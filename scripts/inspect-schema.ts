import "dotenv/config";
import { pool } from "../src/db/index.js";

const tables = await pool.query<{ table_name: string }>(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
);
const botSessionColumns = await pool.query<{ column_name: string }>(
  "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'bot_sessions' order by ordinal_position",
);
const duplicateLiveSessions = await pool.query<{
  user_id: string;
  session_count: string;
}>(
  "select user_id, count(*)::text as session_count from bot_sessions where status in ('pending', 'starting', 'active') group by user_id having count(*) > 1 order by count(*) desc",
);
const duplicateStrategyAccess = await pool.query<{
  strategy_id: string;
  user_id: string;
  access_count: string;
}>(
  "select strategy_id::text, user_id, count(*)::text as access_count from strategy_access group by strategy_id, user_id having count(*) > 1 order by count(*) desc",
);
const migrationTables = await pool.query<{
  table_schema: string;
  table_name: string;
}>(
  "select table_schema, table_name from information_schema.tables where table_name like '%migration%' order by table_schema, table_name",
);
const drizzleMigrations = await pool.query<{
  id: number;
  hash: string;
  created_at: string;
}>(
  'select id, hash, created_at::text from drizzle.__drizzle_migrations order by created_at, id',
);
const roundsColumns = await pool.query<{ column_name: string }>(
  "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'rounds' order by ordinal_position",
);
const relevantIndexes = await pool.query<{
  tablename: string;
  indexname: string;
  indexdef: string;
}>(
  "select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('bot_sessions', 'rounds', 'strategy_access') order by tablename, indexname",
);

console.log(
  JSON.stringify({
    tables: tables.rows.map((row) => row.table_name),
    botSessionColumns: botSessionColumns.rows.map((row) => row.column_name),
    duplicateLiveSessions: duplicateLiveSessions.rows,
    duplicateStrategyAccess: duplicateStrategyAccess.rows,
    migrationTables: migrationTables.rows,
    drizzleMigrations: drizzleMigrations.rows,
    roundsColumns: roundsColumns.rows.map((row) => row.column_name),
    relevantIndexes: relevantIndexes.rows,
  }),
);

await pool.end();
