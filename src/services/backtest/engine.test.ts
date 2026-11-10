import assert from "node:assert/strict";
import test from "node:test";
import { runBacktest } from "./engine.js";
import { runBacktestSchema } from "../../validation/backtests.js";
import { parseAdvancedStrategy } from "../../utils/local-player/strategy/config.js";

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

const profitWindow = {
  type: "adaptive", adaptive: {
    kind: "window", target: 5, roundsMode: "fixed", windowRounds: 1, windowBudget: 10,
    start: "now", windowAfter: "repeat", progression: { type: "multiply", value: 2 }, windowProfitGoal: 250,
  },
};

test("the local 5x profit switch survives request validation and historical settlement", () => {
  const request = runBacktestSchema.parse({ strategy: profitWindow, initialCapital: 1000, includeLedger: true });
  const result = runBacktest({ ...request, strategy: request.strategy!, rounds: rounds(1, 1, 1, 1, 5) });
  assert.deepEqual(result.ledger?.map(row => row.amount), [10, 20, 40, 80, 100]);
  assert.deepEqual(result.ledger?.map(row => row.outcome), ["loss", "loss", "loss", "loss", "win"]);
  assert.equal(result.ledger?.at(-1)?.payout, 500);
  assert.equal(result.summary.totalPaid, 500);
  assert.equal(result.summary.netProfit, 250);
  assert.equal(result.summary.lowestCapital, 850);
  assert.equal(result.summary.highestCapital, 1250);
});

test("a blocked profit progression can restart without restoring the funds it spent", () => {
  const request = runBacktestSchema.parse({ strategy: {
    ...profitWindow, adaptive: { ...profitWindow.adaptive, maximum: 80 },
  }, onBlocked: "restart", initialCapital: 1000, includeLedger: true });
  const input = { ...request, strategy: request.strategy!, rounds: rounds(1, 1, 1, 1, 1, 1) };
  const result = runBacktest(input);
  assert.deepEqual(result.ledger?.map(row => row.amount), [10, 20, 40, 80, 10, 20]);
  assert.equal(result.summary.progressionRestarts, 1);
  assert.equal(result.summary.endingCapital, 820);
  assert.equal(runBacktest({ ...input, onBlocked: "stop" }).summary.totalBets, 4);
});

test("restarting a capped window still requires a fresh trigger and respects explicit stops", () => {
  const adaptive = { ...profitWindow.adaptive, windowProfitGoal: undefined, maximum: 30,
    trigger: 3, start: "after-target", windowAfter: "wait" };
  const input = { strategy: parseAdvancedStrategy({ type: "adaptive", adaptive }), onBlocked: "restart" as const,
    initialCapital: 100, includeLedger: true, rounds: rounds(3, 1, 3, 1, 1, 3, 1) };
  const result = runBacktest(input);
  assert.deepEqual(result.ledger?.map(row => [row.roundIndex, row.amount]), [[1, 10], [3, 20], [6, 10]]);
  assert.equal(result.summary.progressionRestarts, 1);
  const shortOfFunds = runBacktest({ ...input, initialCapital: 55, strategy: parseAdvancedStrategy({ type: "adaptive", adaptive: { ...adaptive, maximum: 100 } }) });
  assert.deepEqual(shortOfFunds.ledger?.map(row => [row.roundIndex, row.amount]), [[1, 10], [3, 20], [6, 10]]);
  const stopped = runBacktest({ ...input, strategy: parseAdvancedStrategy({ type: "adaptive", adaptive: { ...adaptive, windowAfter: "stop" } }) });
  assert.equal(stopped.summary.totalBets, 1);
  assert.equal(stopped.summary.progressionRestarts, 0);
});

test("an unaffordable step restarts at the exact base amount and stops once that would exceed the loss limit", () => {
  for (const config of [strategy, { ...strategy, engine: "local-player" as const }]) {
    const result = runBacktest({ strategy: config, onBlocked: "restart", initialCapital: 100, includeLedger: true,
      scenario: { stopLoss: 25 }, rounds: rounds(1, 1, 1, 1) });
    assert.deepEqual(result.ledger?.map(row => [row.strategyStep, row.amount]), [[0, 10], [0, 10]]);
    assert.equal(result.summary.progressionRestarts, 1);
    assert.equal(result.summary.endingCapital, 80);
    assert.ok(result.summary.stopReason);
    const shortOfFunds = runBacktest({ strategy: config, onBlocked: "restart", initialCapital: 25, includeLedger: true, rounds: rounds(1, 1, 1) });
    assert.deepEqual(shortOfFunds.ledger?.map(row => row.amount), [10, 10]);
    assert.equal(shortOfFunds.summary.endingCapital, 5);
  }
});

test("imported sequences keep the local funds mode and step numbers", () => {
  const request = runBacktestSchema.parse({ strategy: {
    ...strategy, engine: "local-player", execution: { fundsMode: "use-remaining" },
  }, initialCapital: 25, includeLedger: true });
  const result = runBacktest({ ...request, strategy: request.strategy!, rounds: rounds(1, 1, 1) });
  assert.deepEqual(result.ledger?.map(row => [row.strategyStep, row.amount]), [[0, 10], [1, 15]]);
  assert.equal(result.summary.endingCapital, 0);
});

test("a historical trigger arms the following round and missing financial metrics stay unavailable", () => {
  const strategy = parseAdvancedStrategy({
    ...profitWindow,
    adaptive: { ...profitWindow.adaptive, start: "after-target", windowAfter: "wait" },
    execution: { rules: [{ id: "reserve", conditions: [{ metric: "totalReserveFunds", operator: "eq", value: 0 }], action: { type: "stop" } }] },
  });
  const history = rounds(1, 5, 1, 5, 5);
  history[2] = Object.assign(history[2]!, { totalReserveFunds: 0, metricsComplete: false });
  history[4] = Object.assign(history[4]!, { totalReserveFunds: 0, metricsComplete: true });
  const result = runBacktest({ strategy, initialCapital: 1000, rounds: history, includeLedger: true });
  assert.deepEqual(result.ledger?.map(row => [row.roundIndex, row.amount, row.ruleId]), [[2, 10, undefined], [4, 20, "reserve"]]);
  assert.equal(result.summary.roundsSkipped, 3);
  assert.ok(result.summary.stopReason);
});

test("phased and adaptive plans honor the recorded clock and explicit risk overrides", () => {
  const phased = parseAdvancedStrategy({ type: "phased", phased: {
    cycleBudget: 100, baseBet: 10, baseTarget: 2, targetReturn: 2, boostBet: 10, boostRounds: 1, stageRounds: [3],
  }, execution: { maxBets: 1 } });
  const replay = runBacktest({ strategy: phased, initialCapital: 1000, rounds: rounds(1, 1, 2), scenario: { maxBets: 0 } });
  assert.ok(replay.summary.totalBets > 1);
  const timed = parseAdvancedStrategy({ ...profitWindow, execution: { maxDurationMinutes: 0.5 } });
  const result = runBacktest({ strategy: timed, initialCapital: 1000, rounds: rounds(1, 5, 5) });
  assert.equal(result.summary.totalBets, 2);
  assert.match(result.summary.stopReason ?? "", /Time limit/);
});

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
