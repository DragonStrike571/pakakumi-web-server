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
  const [{ db, pool }, { auth }, { default: strategies }, { default: backtests }, { backtestRunner }, { hostedPractice }] = await Promise.all([
    import("../../db/index.js"), import("../../lib/auth.js"), import("../../routes/strategies.js"),
    import("../../routes/backtests.js"), import("./runner.js"), import("./practice.js"),
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

  const fixed = { type: "sequence", engine: "local-player", sequence: { bets: [{ amount: 10, cashout: 2 }] } };
  const example = await post("/backtests/run", { strategy: fixed, initialCapital: 25, source: "examples",
    exampleRounds: [1, 1, 1, 5], includeLedger: true });
  assert.equal(example.status, 200);
  const simulated = await example.json() as typeof result;
  assert.equal(simulated.dataset.rounds, 4);
  assert.deepEqual(simulated.ledger.map(row => row.amount), [10, 10]);
  assert.equal(simulated.summary.netProfit, -20);

  // A tied timestamp straddles the batch boundary. A small limit must not truncate this scope.
  await pg.exec(`INSERT INTO rounds (bust, bust_id, created_at)
    SELECT 2, 'archive-' || i, '2026-01-01'::timestamp FROM generate_series(1, 10002) i`);
  const full = await post("/backtests/run", { strategy: fixed, initialCapital: 1000, range: { all: true, limit: 1 } });
  assert.equal(full.status, 200);
  const archive = await full.json() as typeof result;
  assert.equal(archive.dataset.rounds, 10_009);
  assert.equal(archive.summary.netProfit, 100_010);

  assert.equal((await post("/backtests/practice", { strategy: fixed, name: "Fixed", initialCapital: 25, includeLedger: true })).status, 201);
  const startPractice = { strategy: fixed, initialCapital: 25 };
  assert.equal((await post("/backtests/practice", startPractice)).status, 409);
  hostedPractice.observe({ id: "stale", createdAt: new Date(Date.now() - 1000), bust: 1 });
  const observed = { id: "new", createdAt: new Date(Date.now() + 1000), bust: 1 };
  hostedPractice.observe(observed);
  hostedPractice.observe(observed);
  hostedPractice.observe({ ...observed, id: "next", createdAt: new Date(observed.createdAt.getTime() + 1000), bust: 2 });
  const getPractice = (user: string) => fetch(`http://127.0.0.1:${address.port}/backtests/practice`, { headers: { "x-fixture-user": user } });
  const practice = await (await getPractice("owner")).json() as { session: { running: boolean; result: typeof result } };
  assert.equal(practice.session.result.dataset.rounds, 2);
  assert.deepEqual(practice.session.result.ledger.map(row => row.amount), [10, 10]);
  assert.deepEqual(await (await getPractice("other")).json(), { session: null });
  const stopped = await (await post("/backtests/practice/stop", {})).json() as typeof practice;
  assert.equal(stopped.session.running, false);
});
