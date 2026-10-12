import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runBacktestSchema } from "../src/validation/backtests.ts";
import { runBacktest } from "../src/services/backtest/engine.ts";
const payload = {
  strategy: { type: "sequence", sequence: { bets: [{ amount: 1, cashout: 2 }] } },
  initialCapital: 1_000_000,
  range: { limit: 250_000 },
  scenario: { rules: Array.from({ length: 100 }, (_, i) => ({
    id: `rule-${i}`, conditions: Array.from({ length: 20 }, () => ({ metric: "bust", operator: "eq", value: 0 })), action: { type: "continue" },
  })) },
};
assert.ok(runBacktestSchema.safeParse(payload).success);
const bodyBytes = Buffer.byteLength(JSON.stringify(payload));
assert.ok(bodyBytes < 100 * 1024);
const rounds = Array.from({ length: 50_000 }, (_, i) => ({ id: String(i), bust: 2, createdAt: new Date(0) }));
let timerRan = false;
setTimeout(() => { timerRan = true; }, 0);
const start = performance.now();
const result = runBacktest({ rounds, strategy: payload.strategy, initialCapital: payload.initialCapital, scenario: payload.scenario });
const blockedMs = Math.round(performance.now() - start);
assert.equal(result.summary.roundsProcessed, rounds.length);
assert.equal(timerRan, false);
console.log(JSON.stringify({ probe: "backtest_event_loop", permittedBodyBytes: bodyBytes, measuredRounds: rounds.length, allowedRounds: payload.range.limit, blockedMs, timerRanDuringBacktest: timerRan }));
