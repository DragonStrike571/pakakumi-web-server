import assert from "node:assert/strict";
import test from "node:test";
import { runBacktest } from "./engine.js";
import { runBacktestSchema } from "../../validation/backtests.js";

const strategy = {
  type: "sequence" as const,
  sequence: {
    bets: [
      { amount: 10, cashout: 2 },
      { amount: 20, cashout: 2 },
    ],
  },
};

test("explicit zero risk overrides disable saved limits in custom backtests", () => {
  const scenario = { stopLoss: 0, takeProfit: 0, maxBets: 0 };
  assert.equal(runBacktestSchema.safeParse({ strategy, initialCapital: 100, scenario }).success, true);
  const result = runBacktest({ rounds: rounds(1.1, 1.1, 2), strategy: { ...strategy, execution: { stopLoss: 1, maxBets: 1, takeProfit: 1 } }, initialCapital: 100, scenario });
  assert.equal(result.summary.totalBets, 3);
});

function rounds(...busts: number[]) {
  return busts.map((bust, index) => ({
    id: String(index),
    bust,
    createdAt: new Date(2026, 0, 1, 0, index),
  }));
}

test("backtest applies the sequence to chronological outcomes", () => {
  const result = runBacktest({
    rounds: rounds(1.2, 2.5, 3),
    strategy,
    initialCapital: 100,
  });

  assert.equal(result.summary.totalBets, 3);
  assert.equal(result.summary.wins, 2);
  assert.equal(result.summary.losses, 1);
  assert.equal(result.summary.endingCapital, 120);
});

test("pause-after-win skips exactly the configured number of rounds", () => {
  const result = runBacktest({
    rounds: rounds(2, 1.1, 1.1, 2),
    strategy,
    initialCapital: 100,
    scenario: { afterWin: { action: "pause", pauseRounds: 2 } },
  });

  assert.equal(result.summary.totalBets, 2);
  assert.equal(result.summary.roundsSkipped, 2);
  assert.equal(result.summary.endingCapital, 120);
});

test("a composable rule can stop after a loss streak", () => {
  const result = runBacktest({
    rounds: rounds(1.1, 1.1, 2),
    strategy,
    initialCapital: 100,
    scenario: {
      rules: [{
        id: "two-loss-stop",
        event: "loss",
        conditions: [{
          metric: "consecutiveLosses",
          operator: "gte",
          value: 2,
        }],
        action: { type: "stop" },
      }],
    },
  });

  assert.equal(result.summary.totalBets, 2);
  assert.equal(result.summary.endingCapital, 70);
  assert.match(result.summary.stopReason ?? "", /two-loss-stop/);
});

test("stop-loss prevents further exposure", () => {
  const result = runBacktest({
    rounds: rounds(1.1, 1.1, 1.1),
    strategy,
    initialCapital: 100,
    scenario: { stopLoss: 10 },
  });

  assert.equal(result.summary.totalBets, 1);
  assert.equal(result.summary.endingCapital, 90);
  assert.equal(result.summary.stopReason, "Stop-loss reached");
});

test("strategy stop-after-win and auto-cashout match live execution semantics", () => {
  const result = runBacktest({
    rounds: rounds(2.6, 10),
    strategy: { ...strategy, stopAfterWin: true, autoCashout: 2.5 },
    initialCapital: 100,
    includeLedger: true,
  });

  assert.equal(result.summary.totalBets, 1);
  assert.equal(result.summary.endingCapital, 115);
  assert.equal(result.summary.stopReason, "Strategy is configured to stop after a win");
  assert.equal(result.ledger?.[0]?.cashout, 2.5);
  assert.equal(result.ledger?.[0]?.strategyStep, 0);
});

test("an explicit scenario can override stop-after-win", () => {
  const result = runBacktest({
    rounds: rounds(2, 2),
    strategy: { ...strategy, stopAfterWin: true },
    initialCapital: 100,
    scenario: { afterWin: { action: "continue" } },
  });

  assert.equal(result.summary.totalBets, 2);
});

test("missing financial metrics never masquerade as zero in a rule", () => {
  const result = runBacktest({
    rounds: [{
      ...rounds(2)[0]!,
      totalReserveFunds: null,
      metricsComplete: false,
      gapDetected: true,
    }],
    strategy,
    initialCapital: 100,
    scenario: {
      rules: [{
        id: "zero-reserve-stop",
        conditions: [{ metric: "totalReserveFunds", operator: "lte", value: 0 }],
        action: { type: "stop" },
      }],
    },
  });

  assert.equal(result.summary.stopReason, null);
  assert.equal(result.warnings.length, 2);
});

test("saved execution controls are used when the run requests strategy defaults", () => {
  const result = runBacktest({
    rounds: rounds(2, 2, 2),
    strategy: {
      ...strategy,
      stopAfterWin: true,
      execution: {
        afterWin: { action: "continue" },
        maxBets: 2,
      },
    },
    initialCapital: 100,
    scenario: { afterWin: { action: "strategy" } },
  });

  assert.equal(result.summary.totalBets, 2);
  assert.equal(result.summary.stopReason, "Maximum bet count reached");
});

test("session-round rules use the same one-based numbering as live execution", () => {
  const result = runBacktest({
    rounds: rounds(2, 2),
    strategy,
    initialCapital: 100,
    scenario: {
      rules: [{
        id: "first-round-stop",
        conditions: [{ metric: "roundIndex", operator: "eq", value: 1 }],
        action: { type: "stop" },
      }],
    },
  });

  assert.equal(result.summary.totalBets, 1);
  assert.match(result.summary.stopReason ?? "", /first-round-stop/);
});
