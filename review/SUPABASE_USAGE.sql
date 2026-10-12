-- Paste into Supabase > your project > SQL Editor > New query, then click Run.
-- Read-only: does not change or delete collected data.
BEGIN TRANSACTION READ ONLY;

-- Supabase's database-size report includes all databases in the cluster.
SELECT pg_size_pretty(sum(pg_database_size(datname))) AS cluster_database_size,
       round(sum(pg_database_size(datname)) / 1000000.0, 2) AS cluster_database_mb
FROM pg_database;

-- This app's current database footprint is only part of that total.
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
       round(pg_database_size(current_database()) / 1000000.0, 2) AS database_mb;

-- Largest app tables, including their indexes; row/dead-row counts are estimates.
SELECT relname AS table_name,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       pg_size_pretty(pg_indexes_size(relid)) AS index_size,
       n_live_tup AS estimated_rows,
       n_dead_tup AS estimated_dead_rows,
       last_autovacuum
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 15;

-- Captured rounds and approximate daily table growth at today's capture rate.
-- Estimate includes existing rounds indexes/allocated space; it is not a quota guarantee.
WITH recent AS (
  SELECT count(*) AS captured_last_24_hours FROM public.rounds
  WHERE created_at >= current_timestamp - interval '24 hours'
), footprint AS (
  SELECT pg_total_relation_size('public.rounds') AS bytes,
         greatest(reltuples, 0) AS estimated_rows
  FROM pg_class WHERE oid = 'public.rounds'::regclass
)
SELECT recent.captured_last_24_hours,
       round(footprint.bytes / 1000000.0, 2) AS rounds_table_mb,
       round((footprint.bytes / nullif(footprint.estimated_rows, 0))::numeric, 0) AS estimated_bytes_per_round,
       round((recent.captured_last_24_hours * footprint.bytes /
         nullif(footprint.estimated_rows, 0) / 1000000.0)::numeric, 2) AS estimated_rounds_growth_mb_per_day
FROM recent CROSS JOIN footprint;

COMMIT;
