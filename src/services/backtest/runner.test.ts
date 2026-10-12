import test from "node:test";
import assert from "node:assert/strict";
import { BacktestRunner } from "./runner.js";
import { runBacktest } from "./engine.js";

const input = { rounds: Array.from({ length: 50_000 }, (_, i) => ({ id: String(i), bust: 2, createdAt: new Date(0) })),
  strategy: { type: "sequence" as const, sequence: { bets: [{ amount: 1, cashout: 2 }] } }, initialCapital: 1_000_000,
  scenario: { rules: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, conditions: Array.from({ length: 20 }, () => ({ metric: "bust" as const, operator: "eq" as const, value: 0 })), action: { type: "continue" as const } })) } };

test("worker backtest returns identical results while the collection event loop remains responsive", async () => {
  const runner = new BacktestRunner();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const result = await runner.run(input);
    assert.ok(ticks > 5);
    assert.deepEqual(result.summary, runBacktest(input).summary);
  } finally { clearInterval(timer); await runner.shutdown(); }
});

test("timed out and cancelled workers release capacity for subsequent jobs", async () => {
  const runner = new BacktestRunner(40);
  try { await assert.rejects(runner.run(input), /time limit/); }
  finally { await runner.shutdown(); }
  const second = new BacktestRunner();
  try {
    const controller = new AbortController();
    const job = second.run(input, controller.signal); controller.abort();
    await assert.rejects(job, /cancelled/);
    const result = await second.run({ ...input, rounds: input.rounds.slice(0, 2), scenario: undefined });
    assert.equal(result.summary.roundsProcessed, 2);
  } finally { await second.shutdown(); }
});
