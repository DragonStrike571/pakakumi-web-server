import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export interface GapAnalysis {
  target: number; scope: "since-3000" | "all-history"; totalRounds: number; historicalHits: number;
  historicalRtp: number; expectedMeanGap: number; scopedRounds: number; scopedHits: number; latestRoundAt: string | null;
  points: { occurrence: number; gap: number; cumulativeRound: number; runningMean: number; nextMeanReversion: number; bust: number; createdAt: string }[];
}
const cache = new Map<string, { expires: number; promise: Promise<GapAnalysis> }>();
let activeQueries = 0;
export function getGapAnalysis(target: number, pointLimit: number, database: typeof db = db): Promise<GapAnalysis> {
  const key = `${target}::numeric:${pointLimit}`;
  const existing = database === db ? cache.get(key) : undefined;
  if (existing && existing.expires > Date.now()) return existing.promise;
  const promise = queryGaps(target, pointLimit, database);
  if (database === db) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 15_000, promise });
    void promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  }
  return promise;
}

async function queryGaps(target: number, pointLimit: number, database: typeof db): Promise<GapAnalysis> {
  // Leave pool capacity for collection and ordinary API requests.
  if (activeQueries >= 2) throw new Error("Gap analysis is busy; retry later");
  activeQueries++;
  try {
  // A single statement sees one PostgreSQL snapshot, avoiding dozens of racing count requests.
  const result = await database.execute(sql`
    WITH history AS MATERIALIZED (
      SELECT id, bust, created_at, row_number() OVER (ORDER BY created_at, id) AS position FROM rounds
    ), totals AS (
      SELECT count(*) AS total, count(*) FILTER (WHERE bust >= ${target}::numeric) AS hits, max(created_at) AS latest FROM history
    ), anchor AS (
      SELECT CASE WHEN ${target}::numeric < 3000 THEN coalesce(max(position) FILTER (WHERE bust >= 3000), 0) ELSE 0 END AS position FROM history
    ), scoped AS (
      SELECT h.*, h.position - a.position AS relative_position FROM history h CROSS JOIN anchor a WHERE h.position > a.position
    ), occurrences AS (
      SELECT bust, created_at, relative_position,
        row_number() OVER (ORDER BY position) AS occurrence,
        relative_position - lag(relative_position, 1, 0::bigint) OVER (ORDER BY position) AS gap FROM scoped WHERE bust >= ${target}::numeric
    ), selected AS (
      SELECT * FROM occurrences ORDER BY occurrence DESC LIMIT ${pointLimit}
    )
    SELECT json_build_object(
      'target', ${target}::numeric, 'scope', CASE WHEN a.position > 0 THEN 'since-3000' ELSE 'all-history' END,
      'totalRounds', t.total, 'historicalHits', t.hits,
      'historicalRtp', CASE WHEN t.total > 0 THEN ${target}::numeric * t.hits * 100.0 / t.total ELSE 0 END,
      'expectedMeanGap', CASE WHEN t.hits > 0 THEN t.total * 1.0 / t.hits ELSE 0 END,
      'scopedRounds', t.total - a.position, 'scopedHits', (SELECT count(*) FROM occurrences),
      'latestRoundAt', to_char(t.latest, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'points', coalesce((SELECT json_agg(json_build_object(
        'occurrence', occurrence, 'gap', gap, 'cumulativeRound', relative_position,
        'runningMean', relative_position * 1.0 / occurrence,
        'nextMeanReversion', CASE WHEN t.hits > 0 THEN t.total * 1.0 / t.hits * (occurrence + 1) - relative_position ELSE 0 END,
        'bust', bust, 'createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY occurrence) FROM selected), '[]'::json)
    ) AS analysis FROM totals t CROSS JOIN anchor a
  `);
  return result.rows[0]!.analysis as GapAnalysis;
  } finally { activeQueries--; }
}
