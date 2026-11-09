import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrateDatabase } from "../../db/migrations.js";
import * as schema from "../../db/schema.js";

process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/test";
process.env.BETTER_AUTH_SECRET = "offline-test-fixture-secret-for-strategies";

test("a saved local-player setup backtests database rounds in order and stays private", async context => {
  const [{ db, pool }, { auth }, { default: strategies }, { default: backtests }, { backtestRunner }] = await Promise.all([
    import("../../db/index.js"), import("../../lib/auth.js"), import("../../routes/strategies.js"),
    import("../../routes/backtests.js"), import("./runner.js"),
  ]);
  const pg = new PGlite();
  const fixture = drizzle(pg, { schema });
  context.after(async () => { await backtestRunner.shutdown(); await pg.close(); await pool.end(); });
  await migrateDatabase(pg);
  await fixture.insert(schema.users).values({ id: "owner", name: "Owner", email: "owner@example.test", accessStatus: "active" });
  const start = Date.UTC(2026, 0, 2);
  await fixture.insert(schema.rounds).values([5, 1, 1, 1, 1, 5, 5].reverse().map((bust, index) => ({
    bust, bustId: `fixture-${index}`, createdAt: new Date(start + (6 - index) * 1000),
  })));
  context.mock.method(db, "select", fixture.select.bind(fixture));
  context.mock.method(db, "insert", fixture.insert.bind(fixture));
  context.mock.method(auth.api, "getSession", async ({ headers }: { headers: Headers }) => ({
    user: { id: headers.get("x-fixture-user") ?? "owner", role: "user", accessStatus: "active" },
    session: {},
  }));
  const app = express();
  app.use(express.json());
  app.use("/strategies", strategies);
  app.use("/backtests", backtests);
  const server = createServer(app);
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = (path: string, body: object, user = "owner") => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-fixture-user": user }, body: JSON.stringify(body),
  });

  const response = await post("/strategies", {
    name: "Local 5x switch", config: {
      type: "adaptive", adaptive: { kind: "window", target: 5, windowBudget: 10, roundsMode: "fixed", windowRounds: 1,
        start: "now", windowAfter: "repeat", progression: { type: "multiply", value: 2 }, windowProfitGoal: 250 },
    },
  });
  assert.equal(response.status, 201);
  const strategy = await response.json() as { id: string; config: { adaptive: { windowProfitGoal: number } } };
  assert.equal(strategy.config.adaptive.windowProfitGoal, 250);
  const request = { strategyId: strategy.id, initialCapital: 1000, includeLedger: true, range: {
    startDate: new Date(start + 1000).toISOString(), endDate: new Date(start + 5000).toISOString(),
  } };
  const tested = await post("/backtests/run", request);
  assert.equal(tested.status, 200);
  const result = await tested.json() as { summary: { netProfit: number }; dataset: { rounds: number }; ledger: { amount: number }[] };
  assert.equal(result.dataset.rounds, 5);
  assert.deepEqual(result.ledger.map(row => row.amount), [10, 20, 40, 80, 100]);
  assert.equal(result.summary.netProfit, 250);
  assert.equal((await post("/backtests/run", request, "other")).status, 404);
});
