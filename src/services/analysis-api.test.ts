import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "../db/schema.js";
import { migrateDatabase } from "../db/migrations.js";

process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/test";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
process.env.BETTER_AUTH_SECRET = "offline-analysis-route-fixture-secret";

test("authenticated Analysis reads reconcile legacy snapshots, pending signals and filtered outcomes", async t => {
  const { db, pool } = await import("../db/index.js");
  const pg = new PGlite();
  t.after(async () => { await pg.close(); await pool.end(); });
  await migrateDatabase(pg);
  const fixture = drizzle(pg, { schema });
  for (const method of ["select", "insert", "update", "delete", "execute", "transaction"] as const) {
    t.mock.method(db, method, fixture[method].bind(fixture));
  }
  const { auth } = await import("../lib/auth.js");
  const { default: analysis } = await import("../routes/analysis.js");
  const app = express();
  app.use("/analysis", analysis);
  const server = createServer(app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (path: string, cookie = "") => fetch(`http://127.0.0.1:${address.port}/analysis/${path}`, { headers: { cookie } });
  assert.equal((await get("current")).status, 401);
  const signup = await auth.api.signUpEmail({ asResponse: true, body: { name: "Analysis fixture", email: "analysis@example.test", password: "local-analysis-fixture-password" } });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.getSetCookie().map(header => header.split(";")[0]).join("; ");
  assert.equal((await get("current", cookie)).status, 403);
  await fixture.update(schema.users).set({ accessStatus: "active" }).where(eq(schema.users.email, "analysis@example.test"));
  const signal = { target: 10, confidence: 83, expectedRoundsRemaining: 3, reason: "Recorded gap", roundsElapsed: 1, status: "Active" };
  await fixture.insert(schema.analysisSnapshots).values({ id: 1, activeSignals: [signal], upcomingOpportunities: [],
    stats: { totalSignals: 3, totalHits: 1, accuracy: 33, roundsAnalyzed: 10 } });
  await fixture.insert(schema.systemStats).values({ id: 1, signals: 3, hits: 1 });
  await fixture.insert(schema.pendingSignals).values({ id: "10", target: 10, confidence: 83, maxLifespan: 4 });
  await fixture.insert(schema.signalHistory).values([
    { target: 10, confidence: 83, outcome: "pending" },
    { target: 2, confidence: 75, outcome: "hit" },
    { target: 5, confidence: 82, outcome: "missed" },
  ]);
  const totals = await (await get("stats", cookie)).json();
  const current = await (await get("current", cookie)).json();
  assert.equal(totals.totalResolved, 2);
  assert.equal(totals.accuracy, 50);
  assert.equal(current.stats.accuracy, totals.accuracy);
  assert.equal(current.stats.totalResolved, totals.totalResolved);
  const history = await (await get("history?target=2&outcome=hit", cookie)).json();
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].target, 2);
  assert.equal(history.pagination.total, 1);
  assert.equal((await get("history?target=invalid", cookie)).status, 400);
  assert.equal((await get("gaps?pointLimit=51", cookie)).status, 400);
});
