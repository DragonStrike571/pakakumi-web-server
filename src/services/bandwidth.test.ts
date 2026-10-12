import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { dailyTargetPatch } from "./analysis/daily-target-patch.js";

test("daily target deltas preserve appended/resolved entries and the recent window with much smaller payloads", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE daily_test (targets jsonb NOT NULL)");
    const previous = Array.from({ length: 50 }, (_, i) => ({ target: i + 2, createdAt: new Date(i * 1000).toISOString(), hit: false, resolved: false }));
    await pg.query("INSERT INTO daily_test VALUES ($1::jsonb)", [JSON.stringify(previous)]);
    const next = [...previous.slice(2), ...[52, 53].map(target => ({ target, createdAt: new Date(target * 1000).toISOString(), hit: false, resolved: false }))];
    next[46] = { ...next[46]!, hit: true, resolved: true };
    const query = new PgDialect().sqlToQuery(sql`UPDATE daily_test SET targets = ${dailyTargetPatch(sql`targets`, previous, next)} RETURNING targets`);
    const result = await pg.query<{ targets: typeof next }>(query.sql, query.params);
    assert.deepEqual(result.rows[0]!.targets, next);
    assert.ok(Buffer.byteLength(JSON.stringify(query.params)) < Buffer.byteLength(JSON.stringify(next)) / 8);
    // Retrying a rolled-back patch produces the same result; no counters/entries disappear.
    await pg.exec("BEGIN");
    await pg.query("UPDATE daily_test SET targets = '[]'");
    await pg.exec("ROLLBACK");
    const restarted = new PgDialect().sqlToQuery(sql`UPDATE daily_test SET targets = ${dailyTargetPatch(sql`targets`, next, next.slice(10))} RETURNING targets`);
    assert.deepEqual((await pg.query<{ targets: typeof next }>(restarted.sql, restarted.params)).rows[0]!.targets, next.slice(10));
    for (const replacement of [[], previous.slice(0, 2), [...previous].reverse()]) {
      const query = new PgDialect().sqlToQuery(sql`UPDATE daily_test SET targets = ${dailyTargetPatch(sql`targets`, next.slice(10), replacement)} RETURNING targets`);
      assert.deepEqual((await pg.query<{ targets: typeof previous }>(query.sql, query.params)).rows[0]!.targets, replacement);
      await pg.query("UPDATE daily_test SET targets = $1::jsonb", [JSON.stringify(next.slice(10))]);
    }
  } finally { await pg.close(); }
});
