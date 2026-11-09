import test from "node:test";
import assert from "node:assert/strict";
import { assertPlayableStrategy, type StrategyConfig } from "./strategies/core.js";
test("live eligibility checks limits before a session is queued", () => {
  const sequence = (amount: number, cashout = 2): StrategyConfig => ({ type: "sequence", sequence: { bets: [{ amount, cashout }] } });
  for (const amount of [10, 5000]) assert.doesNotThrow(() => assertPlayableStrategy(sequence(amount)));
  for (const amount of [1, 9.99, 5000.01, 5001, 10.001]) assert.throws(() => assertPlayableStrategy(sequence(amount)));
  assert.throws(() => assertPlayableStrategy(sequence(10, 3001)));
  assert.throws(() => assertPlayableStrategy({ type: "algorithm", algorithm: { capital: 10000, minAmount: 10, multiplier: 2, targetReturn: 1.5, maxPlayable: 6000 } }));
});
