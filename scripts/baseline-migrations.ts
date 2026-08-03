import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/index.js";

const BASELINE_COUNT = 4;
const dryRun = process.argv.includes("--dry-run");
const root = fileURLToPath(new URL("../", import.meta.url));
const journal = JSON.parse(
  await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: Array<{ tag: string; when: number }> };
const baselineEntries = journal.entries.slice(0, BASELINE_COUNT);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Baseline safety check failed: ${message}`);
}

const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext('pakakumi-drizzle-baseline'))");

  const migrations = await client.query<{ id: number; hash: string; created_at: string }>(
    "select id, hash, created_at::text from drizzle.__drizzle_migrations order by created_at, id",
  );
  assert(migrations.rows.length === 0, "the Drizzle journal must be empty");
  assert(baselineEntries.length === BASELINE_COUNT, "the local journal is incomplete");

  const requiredTables = [
    "accounts", "bot_sessions", "rounds", "sessions", "strategies",
    "strategy_access", "users", "verifications",
  ];
  const tables = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])",
    [requiredTables],
  );
  const tableNames = new Set(tables.rows.map((row) => row.table_name));
  for (const table of requiredTables) assert(tableNames.has(table), `missing table ${table}`);

  const requiredColumns: Record<string, string[]> = {
    users: [
      "id", "name", "email", "created_at", "updated_at", "phone",
      "password_hash", "email_verified", "image",
    ],
    rounds: ["id", "created_at", "bust", "bust_id", "gap_detected"],
    bot_sessions: [
      "id", "user_id", "strategy_id", "status", "initial_capital",
      "current_capital", "total_profit", "logs", "current_step",
      "started_at", "ended_at",
    ],
  };
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
  }>(
    "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])",
    [Object.keys(requiredColumns)],
  );
  const columnMap = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  for (const [table, names] of Object.entries(requiredColumns)) {
    for (const name of names) assert(columnMap.has(`${table}.${name}`), `missing column ${table}.${name}`);
  }
  assert(columnMap.get("users.id")?.data_type === "text", "users.id must be text");
  assert(columnMap.get("rounds.gap_detected")?.data_type === "boolean", "rounds.gap_detected must be boolean");
  assert(columnMap.get("rounds.gap_detected")?.is_nullable === "NO", "rounds.gap_detected must be non-null");

  const textUserIdTables = ["accounts", "bot_sessions", "sessions", "strategies", "strategy_access"];
  const userIdColumns = await client.query<{ table_name: string; data_type: string }>(
    "select table_name, data_type from information_schema.columns where table_schema = 'public' and column_name = 'user_id' and table_name = any($1::text[])",
    [textUserIdTables],
  );
  const textUserIds = new Set(
    userIdColumns.rows.filter((row) => row.data_type === "text").map((row) => row.table_name),
  );
  for (const table of textUserIdTables) assert(textUserIds.has(table), `${table}.user_id must be text`);

  const requiredIndexes = [
    "account_user_idx", "bot_sessions_status_idx", "bot_sessions_user_idx",
    "bust_id_idx", "created_at_idx", "email_idx", "phone_idx",
    "session_user_idx", "strategies_user_idx", "strategy_access_strategy_idx",
    "strategy_access_user_idx", "verification_identifier_idx",
  ];
  const indexes = await client.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname = 'public' and indexname = any($1::text[])",
    [requiredIndexes],
  );
  const indexNames = new Set(indexes.rows.map((row) => row.indexname));
  for (const index of requiredIndexes) assert(indexNames.has(index), `missing index ${index}`);

  const requiredConstraints = [
    "accounts_user_id_users_id_fk", "bot_sessions_user_id_users_id_fk",
    "bot_sessions_strategy_id_strategies_id_fk", "sessions_user_id_users_id_fk",
    "strategies_user_id_users_id_fk", "strategy_access_strategy_id_strategies_id_fk",
    "strategy_access_user_id_users_id_fk", "users_phone_unique",
  ];
  const constraints = await client.query<{ conname: string }>(
    "select conname from pg_constraint where conname = any($1::text[])",
    [requiredConstraints],
  );
  const constraintNames = new Set(constraints.rows.map((row) => row.conname));
  for (const constraint of requiredConstraints) {
    assert(constraintNames.has(constraint), `missing constraint ${constraint}`);
  }

  const entries = await Promise.all(baselineEntries.map(async (entry) => {
    const sql = await readFile(`${root}drizzle/${entry.tag}.sql`, "utf8");
    return {
      ...entry,
      hash: createHash("sha256").update(sql).digest("hex"),
    };
  }));

  if (!dryRun) {
    for (const entry of entries) {
      await client.query(
        "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
        [entry.hash, entry.when],
      );
    }
    await client.query("commit");
  } else {
    await client.query("rollback");
  }

  console.log(JSON.stringify({
    mode: dryRun ? "dry-run" : "applied",
    verifiedMigrations: entries.map((entry) => entry.tag),
  }));
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
