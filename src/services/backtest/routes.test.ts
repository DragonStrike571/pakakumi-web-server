import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";
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
  context.mock.method(db, "update", fixture.update.bind(fixture));
  context.mock.method(db, "delete", fixture.delete.bind(fixture));
  context.mock.method(db, "execute", fixture.execute.bind(fixture));
  context.mock.method(db, "transaction", fixture.transaction.bind(fixture));
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
  const get = (path: string, user = "owner") => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { "x-fixture-user": user } });

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
  const result = await tested.json() as { runId: string; summary: { netProfit: number }; dataset: { rounds: number }; ledger: { amount: number }[] };
  assert.equal(result.dataset.rounds, 5);
  assert.deepEqual(result.ledger.map(row => row.amount), [10, 20, 40, 80, 100]);
  assert.equal(result.summary.netProfit, 250);
  assert.equal((await post("/backtests/run", request, "other")).status, 404);
  const savedPath = `/backtests/runs/${result.runId}`;
  const detail = await (await get(savedPath)).json();
  assert.deepEqual(detail.settings.strategy, strategy.config);
  assert.equal((await get(savedPath, "other")).status, 404);
  assert.equal((await get(`${savedPath}/rounds`, "other")).status, 404);
  assert.deepEqual(await (await get("/backtests/runs", "other")).json(), { runs: [], hasMore: false });
  const losses = await (await get(`${savedPath}/rounds?filter=loss`)).json();
  assert.equal(losses.total, 4);
  assert.deepEqual(losses.rows.map((row: { roundIndex: number }) => row.roundIndex), [0, 1, 2, 3]);

  const fixed = { type: "sequence", engine: "local-player", sequence: { bets: [{ amount: 10, cashout: 2 }] } };
  const example = await post("/backtests/run", { strategy: fixed, initialCapital: 25, source: "examples",
    exampleRounds: [1, 1, 1, 5], includeLedger: true });
  assert.equal(example.status, 200);
  const simulated = await example.json() as typeof result;
  assert.equal(simulated.dataset.rounds, 4);
  assert.deepEqual(simulated.ledger.map(row => row.amount), [10, 10]);
  assert.equal(simulated.summary.netProfit, -20);
  const noPlay = await (await get(`/backtests/runs/${simulated.runId}/rounds?filter=observed`)).json();
  assert.equal(noPlay.total, 2);
  assert.deepEqual(noPlay.rows.map((row: { round: { bust: number } }) => row.round.bust), [1, 5]);

  // A tied timestamp straddles the batch boundary. A small limit must not truncate this scope.
  await pg.exec(`INSERT INTO rounds (bust, bust_id, created_at)
    SELECT 2, 'archive-' || i, '2026-01-01'::timestamp FROM generate_series(1, 10002) i`);
  const full = await post("/backtests/run", { strategy: fixed, initialCapital: 1000, range: { all: true, limit: 1 } });
  assert.equal(full.status, 200);
  const archive = await full.json() as typeof result;
  assert.equal(archive.dataset.rounds, 10_009);
  assert.equal(archive.summary.netProfit, 100_010);
  const lastPage = await (await get(`/backtests/runs/${archive.runId}/rounds?page=201&filter=win`)).json();
  assert.equal(lastPage.total, 10_005);
  assert.equal(lastPage.rows.length, 5);

  const originalRounds = await (await get(`${savedPath}/rounds`)).json();
  await fixture.update(schema.rounds).set({ bust: 9 }).where(eq(schema.rounds.bustId, "fixture-1"));
  const replayRequest = { strategy: fixed, initialCapital: 200, replayOf: result.runId };
  assert.equal((await post("/backtests/run", replayRequest, "other")).status, 404);
  const replay = await post("/backtests/run", replayRequest);
  assert.equal(replay.status, 200);
  const replayed = await replay.json() as typeof result;
  assert.deepEqual(replayed.dataset, result.dataset);
  assert.equal(replayed.summary.netProfit, -30);
  const replayPath = `/backtests/runs/${replayed.runId}`;
  assert.equal((await (await get(replayPath)).json()).replayOf, result.runId);
  const replayRounds = await (await get(`${replayPath}/rounds`)).json();
  assert.deepEqual(replayRounds.rows.map((row: { round: object }) => row.round), originalRounds.rows.map((row: { round: object }) => row.round));

  assert.equal((await post("/backtests/practice", { strategy: fixed, name: "Fixed", initialCapital: 25, includeLedger: true })).status, 201);
  const startPractice = { strategy: fixed, initialCapital: 25 };
  assert.equal((await post("/backtests/practice", startPractice)).status, 409);
  await hostedPractice.observe({ id: "stale", createdAt: new Date(Date.now() - 1000), bust: 1 });
  const observed = { id: "new", createdAt: new Date(Date.now() + 1000), bust: 1 };
  await Promise.all([hostedPractice.observe(observed), hostedPractice.observe(observed),
    hostedPractice.observe({ ...observed, id: "next", createdAt: new Date(observed.createdAt.getTime() + 1000), bust: 2 })]);
  const getPractice = (user: string) => fetch(`http://127.0.0.1:${address.port}/backtests/practice`, { headers: { "x-fixture-user": user } });
  const practice = await (await getPractice("owner")).json() as { session: { running: boolean; result: typeof result } };
  assert.equal(practice.session.result.dataset.rounds, 2);
  assert.deepEqual(practice.session.result.ledger.map(row => row.amount), [10, 10]);
  assert.deepEqual(await (await getPractice("other")).json(), { session: null });
  const stopped = await (await post("/backtests/practice/stop", {})).json() as typeof practice;
  assert.equal(stopped.session.running, false);
  const practicePath = `/backtests/runs/${stopped.session.result.runId}`;
  assert.ok((await (await get(practicePath)).json()).finishedAt);
  const practiceReplay = await post("/backtests/run", { ...startPractice, replayOf: stopped.session.result.runId });
  assert.equal(practiceReplay.status, 200);
  const practiceResult = await practiceReplay.json() as typeof result;
  assert.deepEqual(practiceResult.dataset, stopped.session.result.dataset);
  const practiceWins = await (await get(`/backtests/runs/${practiceResult.runId}/rounds?filter=win`)).json();
  assert.equal(practiceWins.total, 1);
  assert.equal(practiceWins.rows[0].round.id, "next");
});
