// Generated from pakakumi-fully-local-player/src/strategy/config.ts by sync-local-player-engine.mjs.
import type { BaseProgression, ExecutionConfig, ExecutionRule, StrategyConfig } from "./core.js";
import { generateAlgorithmBets } from "./core.js";
import type { RunSettings, StrategySettings } from "../types.js";
import { roundAmount, windowAmount, type AdaptiveConfig } from "./adaptive.js";

export const MIN_AMOUNT = 10;
export const MAX_AMOUNT = 5000;
export const MAX_TARGET = 3000;
type ObjectValue = Record<string, unknown>;
export function object(value: unknown, label = "Settings"): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}
export function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (value === "" || value === null || typeof value === "boolean") throw new Error(`${label} is required`);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw new Error(`${label} must be ${integer ? "a whole number " : ""}between ${min} and ${max}`);
  return n;
}
function money(value: unknown, label: string, max = MAX_AMOUNT) {
  const n = number(value, label, MIN_AMOUNT, max);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new Error(`${label} supports two decimal places`);
  return n;
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw new Error(`Choose a valid ${label}`);
  return value as T;
}
function optionalNumber(o: ObjectValue, key: string, min: number, max: number, integer = false) {
  return o[key] === undefined ? undefined : number(o[key], key, min, max, integer);
}
function parseBaseProgression(value: unknown): BaseProgression {
  const change = object(value, "Base increase after a miss");
  const type = choice(change.type, ["add", "multiply"] as const, "base increase");
  const amount = number(change.value, type === "add" ? "Base increase" : "Base multiplier", type === "add" ? 0.01 : 1.000001, 1e6);
  if (type === "add" && Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw new Error("Base increases support two decimal places");
  return { type, value: amount, every: number(change.every ?? 1, "Misses before increasing the base", 1, 100000, true) };
}
const actions = ["strategy", "continue", "reset", "pause", "stop"] as const;
const metrics = ["bust", "capital", "profit", "drawdown", "consecutiveWins", "consecutiveLosses", "roundsSinceWin", "roundsSinceLoss", "roundsSinceLast3000", "totalReserveFunds", "roundIndex"] as const;
export function parseExecution(value: unknown): ExecutionConfig {
  const o = value === undefined ? {} : object(value, "Rules");
  const result: ExecutionConfig = {};
  if (o.fundsMode !== undefined) result.fundsMode = choice(o.fundsMode, ["planned", "use-remaining"] as const, "funds mode");
  for (const key of ["afterWin", "afterLoss"] as const) {
    if (o[key] === undefined) continue;
    const d = object(o[key]);
    result[key] = { action: choice(d.action, actions, "outcome action"), pauseRounds: optionalNumber(d, "pauseRounds", 0, 100000, true) };
  }
  for (const key of ["stopLoss", "takeProfit"] as const) if (o[key] !== undefined) result[key] = number(o[key], key, 0.01, 1e9);
  for (const key of ["maxBets", "maxCycles"] as const) if (o[key] !== undefined) result[key] = number(o[key], key, 1, 1e6, true);
  if (o.maxDurationMinutes !== undefined) result.maxDurationMinutes = number(o.maxDurationMinutes, "Maximum minutes", 0.01, 10080);
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules) || o.rules.length > 100) throw new Error("Use at most 100 rules");
    const ids = new Set<string>();
    result.rules = o.rules.map((raw, index): ExecutionRule => {
      const rule = object(raw, "Rule");
      const id = typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : `rule-${index + 1}`;
      if (id.length > 100 || ids.has(id)) throw new Error("Rule names must be unique and under 100 characters");
      ids.add(id);
      if (!Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > 20) throw new Error("Each rule needs 1–20 conditions");
      const action = object(rule.action, "Rule action");
      return { id, event: choice(rule.event ?? "any", ["any", "win", "loss"] as const, "rule event"), match: choice(rule.match ?? "all", ["all", "any"] as const, "condition match"),
        once: rule.once === true,
        conditions: rule.conditions.map(rawCondition => { const c = object(rawCondition); return {
          metric: choice(c.metric, metrics, "metric"), operator: choice(c.operator, ["eq", "neq", "gt", "gte", "lt", "lte"] as const, "comparison"), value: number(c.value, "Condition value", -1e12, 1e12),
        }; }),
        action: { type: choice(action.type, ["stop", "pause", "reset", "continue", "jump"] as const, "rule action"), rounds: optionalNumber(action, "rounds", 0, 100000, true), step: optionalNumber(action, "step", 0, 9999, true) },
      };
    });
  }
  return result;
}

export function parsePhase(value: unknown): Omit<StrategySettings, "initialCapital"> {
  const o = object(value);
  const baseBet = money(o.baseBet, "Starting amount");
  const maxBet = money(o.maxBet ?? 5000, "Maximum amount");
  if (maxBet < baseBet) throw new Error("Maximum amount must cover the starting amount");
  const raw = typeof o.stageRounds === "string" ? o.stageRounds.split(",").map(part => part.trim()) : o.stageRounds;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new Error("Use 1–3 increasing phase lengths");
  const stageRounds = raw.map(n => number(n, "Phase length", 1, 80, true));
  if (stageRounds.some((n, i) => i > 0 && n <= stageRounds[i - 1]!)) throw new Error("Phase lengths must increase");
  return { baseBet, maxBet, cycleBudget: money(o.cycleBudget, "Cycle allocation", 1e9), baseTarget: number(o.baseTarget, "Target multiplier", 1.01, MAX_TARGET), targetReturn: number(o.targetReturn, "Sizing factor", 0.01, 1e6),
    boostBet: money(o.boostBet, "Second-phase amount", maxBet), boostRounds: number(o.boostRounds, "Second-phase rounds", 1, 80, true), stageRounds, profitFundedBoost: o.profitFundedBoost !== false };
}

export function parseStrategy(value: unknown): StrategyConfig {
  const o = object(value, "Strategy");
  const type = choice(o.type, ["sequence", "algorithm", "phased", "adaptive"] as const, "strategy type");
  const result: StrategyConfig = { type, execution: parseExecution(o.execution) };
  if (o.engine !== undefined) result.engine = choice(o.engine, ["local-player"] as const, "strategy engine");
  if (o.stopAfterWin !== undefined) result.stopAfterWin = o.stopAfterWin === true;
  if (o.autoCashout !== undefined) result.autoCashout = number(o.autoCashout, "Target multiplier", 1.01, MAX_TARGET);
  if (type === "sequence") {
    const seq = object(o.sequence);
    if (!Array.isArray(seq.bets) || seq.bets.length < 1 || seq.bets.length > 10000) throw new Error("A sequence needs 1–10,000 steps");
    result.sequence = { bets: seq.bets.map((raw, index) => { const b = object(raw); return { amount: money(b.amount, `Step ${index + 1} amount`), cashout: number(b.cashout, `Step ${index + 1} multiplier`, 1.01, MAX_TARGET) }; }) };
  } else if (type === "algorithm") {
    const a = object(o.algorithm);
    result.algorithm = { capital: money(a.capital, "Cycle allocation", 1e9), minAmount: money(a.minAmount, "Starting amount"), multiplier: number(a.multiplier, "Target multiplier", 1.01, MAX_TARGET), targetReturn: number(a.targetReturn, "Sizing factor", 0.01, 1e6), roundingOption: choice(a.roundingOption ?? "none", ["none", "whole", "five", "ten"] as const, "rounding"), maxPlayable: money(a.maxPlayable ?? MAX_AMOUNT, "Maximum amount") };
    if (a.baseAfterMiss !== undefined) result.algorithm.baseAfterMiss = parseBaseProgression(a.baseAfterMiss);
    if (result.algorithm.maxPlayable! < result.algorithm.minAmount) throw new Error("Maximum amount must cover the starting amount");
    if (!generateAlgorithmBets(result.algorithm.capital, result.algorithm.minAmount, result.algorithm.multiplier, result.algorithm.targetReturn, result.algorithm.roundingOption, result.algorithm.maxPlayable, result.algorithm.baseAfterMiss).length) throw new Error("This configuration produces no steps");
  } else if (type === "phased") {
    result.phased = parsePhase(o.phased);
    if (result.autoCashout) result.phased.baseTarget = result.autoCashout;
    if (result.execution?.rules?.some(r => r.action.type === "jump" || r.action.step !== undefined)) throw new Error("Step navigation rules need a sequence or calculated strategy");
  } else {
    result.adaptive = parseAdaptive(o.adaptive);
    if (result.autoCashout) {
      if (result.adaptive.returnCalculation === "website") result.adaptive.calculationTarget ??= result.adaptive.target;
      result.adaptive.target = result.autoCashout;
      result.adaptive = parseAdaptive(result.adaptive);
    }
    if (result.adaptive.returnCalculation !== "website" && result.execution?.rules?.some(r => r.action.type === "jump" || r.action.step !== undefined)) throw new Error("Step navigation rules need calculated Target Return or a custom sequence");
  }
  return result;
}

export type AdvancedStrategyConfig = StrategyConfig & { type: "adaptive" | "phased" };

export function parseAdvancedStrategy(value: unknown): AdvancedStrategyConfig {
  const strategy = parseStrategy(value);
  if (strategy.type !== "adaptive" && strategy.type !== "phased") throw new Error("Choose an adaptive or phased strategy");
  return { ...strategy, type: strategy.type };
}

export function usesLocalPlayerEngine(strategy: { type: string; engine?: "local-player" }) {
  return strategy.engine === "local-player" || strategy.type === "adaptive" || strategy.type === "phased";
}

export function parseAdaptive(value: unknown): AdaptiveConfig {
  const o = object(value, "Play settings"), kind = choice(o.kind, ["compound", "roi", "window"] as const, "approach");
  const minimum = money(o.minimum ?? 10, "Minimum amount"), maximum = money(o.maximum ?? 5000, "Maximum amount");
  if (maximum < minimum) throw new Error("Maximum amount must cover the minimum");
  const target = number(o.target ?? 100, "Target multiplier", 1.01, MAX_TARGET), factor = number(o.factor ?? 10, "Window factor", 0.01, 3000);
  const roundsMode = choice(o.roundsMode ?? "factor", ["factor", "fixed"] as const, "round calculation");
  const windowRounds = roundsMode === "fixed" ? number(o.windowRounds, "Rounds per window", 1, 100000, true) : Math.floor(target / factor);
  if ((kind === "window" || o.windowEnabled === true) && (windowRounds < 1 || windowRounds > 100000)) throw new Error("Target divided by factor must produce 1–100,000 rounds");
  const windowBudget = money(o.windowBudget ?? 100, "Window amount", 1e9);
  const p = o.progression === undefined ? {} : object(o.progression), progressionType = choice(p.type ?? "fixed", ["fixed", "multiply", "add", "budgets", "increments"] as const, "next window amount");
  const rawValues = typeof p.values === "string" ? p.values.split(/[,\s]+/).filter(Boolean) : p.values ?? [];
  if (!Array.isArray(rawValues) || rawValues.length > 1000) throw new Error("Use at most 1,000 window amounts");
  const values = rawValues.map(n => number(n, "Window list value", progressionType === "increments" ? 0.01 : 10, 1e9));
  if (["budgets", "increments"].includes(progressionType) && values.length === 0) throw new Error("Enter the window amounts or increases");
  const firstBudget = progressionType === "budgets" ? values[0]! : windowBudget;
  if (kind === "window" && firstBudget < minimum * windowRounds) throw new Error(`${windowRounds} rounds need at least KES ${(minimum * windowRounds).toLocaleString("en-US")}. Increase the window amount or reduce the rounds.`);
  const result: AdaptiveConfig = {
    kind, target, minimum, maximum, rounding: choice(o.rounding ?? "cents", ["cents", "nearest-whole", "up-whole", "down-whole", "nearest-five", "up-five", "down-five", "nearest-ten", "up-ten"] as const, "rounding"),
    start: choice(o.start ?? (kind === "window" ? "after-target" : "now"), ["now", "after-target"] as const, "start condition"), trigger: number(o.trigger ?? target, "Start after multiplier", 1.01, MAX_TARGET),
    afterHit: choice(o.afterHit ?? (kind === "window" ? "restart-window" : "continue"), ["continue", "wait", "stop", "restart-window"] as const, "action after target"),
    fractionBasis: choice(o.fractionBasis ?? "current", ["current", "initial", "available"] as const, "amount calculation"),
    baseAmount: money(o.baseAmount ?? minimum, "Starting amount", maximum), returnMode: choice(o.returnMode ?? "multiple", ["multiple", "profit"] as const, "return goal"),
    returnMultiple: number(o.returnMultiple ?? 2, "Return multiple", 0.01, 1e6), goalProfit: number(o.goalProfit ?? 500, "Profit per cycle", 0, 1e9), adjustBeforeRound: o.adjustBeforeRound === true,
    resetSpentOnHit: o.resetSpentOnHit !== false, cycleBudget: money(o.cycleBudget ?? 5000, "Cycle amount", 1e9), cycleEnd: choice(o.cycleEnd ?? "restart", ["restart", "wait", "stop"] as const, "cycle end"),
    factor, roundsMode, windowRounds: Math.max(1, windowRounds), windowEnabled: kind === "window" || o.windowEnabled === true, windowAfter: choice(o.windowAfter ?? "wait", ["wait", "repeat", "stop"] as const, "window end"), resetSpentAfterWindow: o.resetSpentAfterWindow === true,
    windowBudget: firstBudget, progression: { type: progressionType, value: number(p.value ?? 2, "Window change", 0.01, 1e6), values, repeat: p.repeat === true }, hitBudget: choice(o.hitBudget ?? "reset", ["reset", "keep", "advance"] as const, "window amount after a target"),
  };
  if (o.returnCalculation !== undefined) {
    if (kind !== "roi") throw new Error("Return calculation applies to Target Return");
    result.returnCalculation = choice(o.returnCalculation, ["website", "cycle"] as const, "return calculation");
    if (result.returnCalculation === "website" && (result.returnMode !== "multiple" || result.adjustBeforeRound)) {
      throw new Error("The website calculation uses a return factor after each completed play");
    }
  }
  if (o.calculationTarget !== undefined) result.calculationTarget = number(o.calculationTarget, "Calculation multiplier", 1.01, MAX_TARGET);
  if (result.returnCalculation === "website") {
    const first = Math.max(minimum, roundAmount(result.baseAmount, result.rounding));
    if (first > maximum || first > result.cycleBudget) throw new Error(`The cycle allocation and maximum amount must cover the first KES ${first.toFixed(2)} play`);
  }
  if (o.baseAfterMiss !== undefined) {
    if (kind !== "roi") throw new Error("Base increases after a miss apply to the target return strategy");
    const change = object(o.baseAfterMiss, "Base increase after a miss");
    result.baseAfterMiss = { ...parseBaseProgression(change), resetOnHit: change.resetOnHit !== false };
  }
  if (o.attempts !== undefined) {
    if (kind !== "roi" || result.returnCalculation !== "website") throw new Error("Attempt controls require the website Target Return calculation");
    if (result.baseAfterMiss || result.windowEnabled) throw new Error("Attempt controls replace per-round base increases and fixed-length windows. Disable those options first.");
    const a = object(o.attempts, "Attempt settings");
    const rows = a.increases ?? [];
    if (!Array.isArray(rows) || rows.length > 100) throw new Error("Use at most 100 ordered attempt increases");
    const outcome = (value: unknown, hit: boolean) => {
      const row = value === undefined ? {} : object(value, "Action after attempt");
      return { action: choice(row.action ?? (hit ? "restart" : "advance"), hit ? ["restart", "finish", "stop"] as const : ["advance", "repeat", "stop"] as const, "attempt action"),
        timing: choice(row.timing ?? "trigger", ["immediate", "trigger"] as const, "next attempt timing"),
        pauseRounds: number(row.pauseRounds ?? 0, "Rounds to wait", 0, 100000, true) };
    };
    result.attempts = { increases: rows.map(raw => {
      const row = object(raw, "Attempt increase");
      const type = choice(row.type, ["multiply", "add-base", "add-budget"] as const, "attempt increase");
      const value = number(row.value, "Attempt increase", type === "multiply" ? 1.000001 : 0.01, 1e6);
      if (type !== "multiply" && Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw new Error("Fixed increases support two decimal places");
      return { type, value, times: number(row.times ?? 1, "Failed attempts for this increase", 1, 100000, true) };
    }), afterIncreases: choice(a.afterIncreases ?? "last", ["last", "repeat", "hold"] as const, "end of increase list"),
    afterMiss: outcome(a.afterMiss, false), afterHit: outcome(a.afterHit, true), resetOnHit: a.resetOnHit !== false };
    if (a.onBlocked !== undefined) result.attempts.onBlocked = choice(a.onBlocked, ["stop", "restart"] as const, "action when the next attempt cannot fit");
    if (a.profitFloor !== undefined) { const floor = object(a.profitFloor, "Profit to maintain"); result.attempts.profitFloor = {
      amount: number(floor.amount, "Net profit to maintain", 0.01, 1e9), scope: choice(floor.scope ?? "since-hit", ["since-hit", "session"] as const, "profit calculation") }; }
  }
  if (o.windowProfitGoal !== undefined) {
    if (kind !== "window" || progressionType !== "multiply") throw new Error("The profit target switch requires a multiplying play window");
    if (target <= windowRounds) throw new Error("For the profit target switch, the target multiplier must be higher than the number of rounds per window");
    result.windowProfitGoal = number(o.windowProfitGoal, "Net profit target after a hit", 0.01, 1e9);
  }
  if (o.fractionPercent !== undefined) result.fractionPercent = number(o.fractionPercent, "Percentage of funds", 0.001, 100);
  if (kind === "roi" && result.adjustBeforeRound && result.returnMode === "multiple" && result.returnMultiple >= (result.calculationTarget ?? target)) throw new Error("The return multiple must be below the calculation multiplier");
  if (kind === "roi" && result.cycleBudget < result.baseAmount) throw new Error("Cycle amount must cover the starting amount");
  if (o.protection !== undefined) { const protection = object(o.protection); result.protection = { profit: number(protection.profit, "Profit to protect", 0.01, 1e9), keepInitial: protection.keepInitial !== false, maxUsePercent: number(protection.maxUsePercent ?? 40, "Maximum percentage available after profit", 0.01, 100), raiseOnWin: protection.raiseOnWin !== false }; }
  return result;
}

export function toRunSettings(value: RunSettings | StrategySettings | Record<string, unknown>): RunSettings {
  const o = object(value);
  const initialCapital = money(o.initialCapital, "Session funds", 1e9);
  const strategy = o.strategy ? parseStrategy(o.strategy) : parseStrategy({ type: "phased", phased: o });
  const result: RunSettings = { initialCapital, strategy, maxBet: money(o.maxBet ?? MAX_AMOUNT, "Maximum amount"), mode: choice(o.mode ?? "live", ["practice", "live"] as const, "mode") };
  if (result.mode === "practice") result.practiceSource = choice(o.practiceSource ?? "examples", ["public", "examples"] as const, "practice source");
  if (result.practiceSource === "public" && (o.practiceResults !== undefined || o.practiceDelayMs !== undefined)) throw new Error("Live practice uses Pakakumi's public rounds. Choose example playback to set results or playback speed.");
  if (strategy.type === "phased" && strategy.phased!.cycleBudget > initialCapital) throw new Error("Cycle allocation cannot exceed session funds");
  if (strategy.execution?.fundsMode !== "use-remaining" && strategy.adaptive?.kind === "window") {
    const a=strategy.adaptive;
    if(windowAmount(a.windowBudget,a.windowRounds,a.minimum,Math.min(a.maximum,result.maxBet),a.rounding).amount*a.windowRounds>initialCapital+1e-7)throw new Error("Session funds must cover the first complete window");
  }
  if (typeof o.strategyName === "string") result.strategyName = o.strategyName.slice(0, 120);
  if (o.replayRunId !== undefined) {
    if (result.mode !== "practice" || result.practiceSource !== "examples" || typeof o.replayRunId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(o.replayRunId)) throw new Error("Recorded rounds can only be replayed in practice");
    result.replayRunId = o.replayRunId;
  }
  if (o.practiceDelayMs !== undefined) result.practiceDelayMs = number(o.practiceDelayMs, "Practice speed", 0, 5000, true);
  if (o.practiceResults !== undefined) {
    const raw = typeof o.practiceResults === "string" ? o.practiceResults.split(/[,\s]+/).filter(Boolean) : o.practiceResults;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10000) throw new Error("Use 1–10,000 practice results");
    result.practiceResults = raw.map(n => number(n, "Practice result", 1, 1e6));
  }
  return result;
}

export const DEFAULT_STRATEGIES = [
  { id: "fixed", name: "Fixed amount", config: { type: "sequence", sequence: { bets: [{ amount: 10, cashout: 2 }] }, execution: { stopLoss: 150, maxBets: 100, maxDurationMinutes: 60 } } },
  { id: "calculated", name: "Calculated steps", config: { type: "algorithm", algorithm: { capital: 1500, minAmount: 10, multiplier: 2, targetReturn: 1.5, maxPlayable: 5000, roundingOption: "none" }, execution: { stopLoss: 150, maxBets: 100, maxDurationMinutes: 60 } } },
  { id: "phased", name: "Phased allocation", config: { type: "phased", phased: { cycleBudget: 1500, baseBet: 10, baseTarget: 100, targetReturn: 2, maxBet: 5000, boostBet: 100, boostRounds: 10, stageRounds: [20,40,80], profitFundedBoost: true }, execution: { stopLoss: 150, maxBets: 100, maxDurationMinutes: 60, maxCycles: 1 } } },
] as const;
