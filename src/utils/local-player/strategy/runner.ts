// Generated from pakakumi-fully-local-player/src/strategy/runner.ts by sync-local-player-engine.mjs.
import { generateAlgorithmBets, type ExecutionRuleMetric, type StrategyConfig } from "./core.js";
import { StrategyEngine } from "./engine.js";
import { toRunSettings } from "./config.js";
import type { RunSettings, StrategySettings, RunEvent } from "../types.js";
import { AdaptivePlan } from "./adaptive.js";

export interface Bet { amount: number; cashout: number }
export interface RecordedRoundMetrics {
  roundsSinceLast3000?: number | null;
  totalReserveFunds?: number | null;
}
const cents = (n: number) => Math.round(n * 100) / 100;
function compare(a: number, op: string, b: number) {
  switch (op) { case "eq": return a === b; case "neq": return a !== b; case "gt": return a > b; case "gte": return a >= b; case "lt": return a < b; case "lte": return a <= b; default: return false; }
}

/** Compile amounts once. Round processing visits only configured conditions. */
export class StrategyRunner {
  readonly settings: RunSettings;
  private readonly config: StrategyConfig;
  private readonly bets: Bet[];
  private readonly phase: StrategyEngine | null;
  private readonly adaptive: AdaptivePlan | null;
  private step = 0;
  private capital: number;
  private peak: number;
  private low: number;
  private maxDrop = 0;
  private smallest: number | null = null;
  private largest: number | null = null;
  private trail: number[];
  private played = 0;
  private rounds = 0;
  private cycle = 1;
  private pause = 0;
  private skippingPausedRound = false;
  private wins = 0;
  private losses = 0;
  private sinceWin = 0;
  private sinceLoss = 0;
  private since3000: number | null = null;
  private fired = new Set<string>();
  private lastBust: number | null = null;
  private startedAt: number;
  stopReason: string | null = null;
  readonly unavailableMetrics: string[];

  constructor(input: RunSettings | StrategySettings, private clock: () => number = Date.now, private onHistory?: (event: RunEvent) => void) {
    this.settings = toRunSettings(input);
    this.config = this.settings.strategy;
    this.capital = this.peak = this.low = this.settings.initialCapital;
    this.trail = [this.capital];
    this.startedAt = clock();
    const a = this.config.algorithm;
    this.bets = this.config.type === "algorithm" && a ? generateAlgorithmBets(a.capital, a.minAmount, a.multiplier, a.targetReturn, a.roundingOption, a.maxPlayable) : this.config.sequence?.bets ?? [];
    if (this.config.autoCashout) this.bets = this.bets.map(b => ({ ...b, cashout: this.config.autoCashout! }));
    this.phase = this.config.type === "phased" ? new StrategyEngine({ initialCapital: this.capital, ...this.config.phased! }) : null;
    this.adaptive = this.config.type === "adaptive" ? new AdaptivePlan({ ...this.config.adaptive!, maximum: Math.min(this.config.adaptive!.maximum, this.settings.maxBet) }, this.capital) : null;
    if (!this.phase && !this.adaptive && !this.bets.length) throw new Error("This strategy has no steps");
    if (this.bets.some(b => b.amount > this.settings.maxBet)) throw new Error("A strategy step exceeds the session maximum amount");
    if (this.phase && (this.config.phased!.maxBet > this.settings.maxBet || this.config.phased!.boostBet > this.settings.maxBet)) throw new Error("Phase amounts exceed the session maximum");
    this.unavailableMetrics = this.config.execution?.rules?.some(r => r.conditions.some(c => c.metric === "totalReserveFunds")) ? ["Reserve funds are unavailable; conditions using them do not match."] : [];
  }

  startClock() { this.startedAt = this.clock(); }
  get stepIndex() { return this.step; }
  observeRound(bust: number) {
    if (!Number.isFinite(bust) || bust < 1) throw new Error("Invalid round result");
    this.rounds++; this.sinceWin++; this.sinceLoss++;
    this.skippingPausedRound = false;
    this.lastBust = bust;
    const triggered = this.adaptive?.observe(bust) ?? false;
    if (bust >= 3000) this.since3000 = 0;
    else if (this.since3000 !== null) this.since3000++;
    this.onHistory?.({ type: "round", ordinal: this.rounds, bust, time: this.clock(), capital: this.capital });
    return triggered;
  }

  nextBet(): Bet | null {
    if (this.limited()) return null;
    if (this.skippingPausedRound) return null;
    if (this.pause > 0) { this.pause--; this.skippingPausedRound = true; return null; }
    const useRemaining = this.config.execution?.fundsMode === "use-remaining";
    let bet = this.adaptive ? this.adaptive.next(this.capital, useRemaining) : this.phase ? this.phase.nextBet() : this.bets[this.step]!;
    if (this.adaptive) { this.cycle = this.adaptive.cycle; if (this.adaptive.stopReason) this.stopReason = this.adaptive.stopReason; }
    if (!bet || this.limited()) return null;
    if (useRemaining) { if (this.capital < 10) { this.stopReason = "Playable funds are below KES 10."; return null; } bet = { ...bet, amount: Math.min(bet.amount, this.capital) }; }
    if (bet.amount > this.capital) { this.stopReason = "Session funds cannot cover the next amount."; return null; }
    const limit = this.config.execution?.stopLoss;
    if (limit !== undefined && this.settings.initialCapital - this.capital + bet.amount > limit + 1e-7) { this.stopReason = "The next amount would exceed the session loss limit."; return null; }
    return { ...bet };
  }

  canSubmit(amount: number) {
    if (this.limited()) return false;
    if (this.pause > 0 || this.skippingPausedRound) return false;
    const limit = this.config.execution?.stopLoss;
    return amount <= this.capital && amount <= this.settings.maxBet && (!this.adaptive || this.adaptive.canUse(amount, this.capital)) && (limit === undefined || this.settings.initialCapital - this.capital + amount <= limit + 1e-7);
  }

  settle(bust: number | null, bet: Bet, payout: number, reviewed = false, recorded?: RecordedRoundMetrics) {
    if (!Number.isFinite(payout) || payout < 0) throw new Error("Invalid recorded payment");
    const net = cents(payout - bet.amount);
    const won = payout > 0;
    this.capital = cents(this.capital + net);
    this.peak = Math.max(this.peak, this.capital);
    this.low = Math.min(this.low, this.capital); this.maxDrop = Math.max(this.maxDrop, cents(this.peak - this.capital));
    this.trail.push(this.capital); if(this.trail.length>121)this.trail.shift();
    this.smallest = Math.min(this.smallest ?? bet.amount, bet.amount); this.largest = Math.max(this.largest ?? bet.amount, bet.amount);
    this.played++; if (bust !== null) this.lastBust = bust;
    if (won) { this.wins++; this.losses = 0; this.sinceWin = 0; }
    else { this.losses++; this.wins = 0; this.sinceLoss = 0; }
    const events = this.adaptive?.settle(bet.amount, payout, this.capital) ?? this.phase?.settleRound(bust ?? 1, bet, payout).events ?? [];
    const nextStep = won ? 0 : (this.step + 1) % this.bets.length;
    const execution = this.config.execution;
    const values: Record<ExecutionRuleMetric, number | null> = {
      bust, capital: this.capital, profit: cents(this.capital - this.settings.initialCapital), drawdown: cents(this.peak - this.capital), consecutiveWins: this.wins, consecutiveLosses: this.losses, roundsSinceWin: this.sinceWin, roundsSinceLoss: this.sinceLoss, roundsSinceLast3000: recorded?.roundsSinceLast3000 === undefined ? this.since3000 : recorded.roundsSinceLast3000, totalReserveFunds: recorded?.totalReserveFunds ?? null, roundIndex: this.rounds,
    };
    const rule = execution?.rules?.find(r => {
      if (r.once && this.fired.has(r.id) || r.event && r.event !== "any" && r.event !== (won ? "win" : "loss")) return false;
      const test = (c: typeof r.conditions[number]) => values[c.metric] !== null && compare(values[c.metric]!, c.operator, c.value);
      return r.match === "any" ? r.conditions.some(test) : r.conditions.every(test);
    });
    const directive = won ? execution?.afterWin : execution?.afterLoss;
    const action = rule?.action.type ?? directive?.action ?? "strategy";
    if (rule) { if (rule.once) this.fired.add(rule.id); events.push(`Rule: ${rule.id}.`); }
    if (action === "stop" || won && this.config.stopAfterWin && action === "strategy") this.stopReason = "Strategy requested a stop.";
    else if (action === "pause") {
      this.pause = rule?.action.rounds ?? directive?.pauseRounds ?? 0;
      if (!this.phase && !this.adaptive) { this.step = rule?.action.step === undefined ? nextStep : Math.min(rule.action.step, this.bets.length - 1); if (this.step === 0) this.cycle++; }
    } else if (action === "reset") {
      if (this.adaptive) this.adaptive.reset(); else if (this.phase) this.phase.reset(); else { this.step = 0; this.cycle++; }
    } else if (this.adaptive) {
      if (action === "continue") this.adaptive.resume();
    } else if (!this.phase) {
      this.step = action === "jump" ? Math.min(rule?.action.step ?? 0, this.bets.length - 1) : action === "continue" ? (this.step + 1) % this.bets.length : nextStep;
      if (this.step === 0) this.cycle++;
    }
    if (this.phase) this.cycle = this.phase.cycleCount();
    if (this.adaptive) { this.cycle = this.adaptive.cycle; if (this.adaptive.stopReason) this.stopReason = this.adaptive.stopReason; }
    this.limited();
    this.onHistory?.({ type: "result", ordinal: reviewed || this.rounds === 0 ? null : this.rounds, played: this.played, bust, time: this.clock(), amount: bet.amount, target: bet.cashout, payout, capital: this.capital, reviewed });
    return { netProfit: net, events, ruleId: rule?.id };
  }

  private limited() {
    if (this.stopReason) return true;
    const e = this.config.execution;
    if (e?.fundsMode === "use-remaining" && (this.adaptive?.usable(this.capital) ?? this.capital) < (this.config.adaptive?.minimum ?? 10)) this.stopReason = `Playable funds are below KES ${this.config.adaptive?.minimum ?? 10}.${(this.adaptive?.usable(this.capital) ?? this.capital) < this.capital ? " Protected funds are kept aside." : ""}`;
    else if (e?.maxBets !== undefined && this.played >= e.maxBets) this.stopReason = "Maximum attempts reached.";
    else if (e?.takeProfit !== undefined && this.capital - this.settings.initialCapital >= e.takeProfit - 1e-7) this.stopReason = "Profit limit reached.";
    else if (e?.stopLoss !== undefined && this.settings.initialCapital - this.capital >= e.stopLoss - 1e-7) this.stopReason = "Session loss limit reached.";
    else if (e?.maxDurationMinutes !== undefined && this.clock() - this.startedAt >= e.maxDurationMinutes * 60000) this.stopReason = "Time limit reached.";
    else if (e?.maxCycles !== undefined && this.cycle > e.maxCycles) this.stopReason = "Maximum cycles reached.";
    return this.stopReason !== null;
  }

  snapshot() {
    const next = this.phase?.nextBet() ?? this.bets[this.step], plan = this.adaptive?.view(this.capital);
    const pausedRounds = this.pause + (this.skippingPausedRound ? 1 : 0);
    return { clockStartedAt: this.startedAt, capitalTrail: [...this.trail], initialCapital: this.settings.initialCapital, highestCapital: this.peak, lowestCapital: this.low, maxDrawdown: this.maxDrop, smallestAmount: this.smallest, largestAmount: this.largest, currentCapital: this.capital, totalProfit: cents(this.capital - this.settings.initialCapital), phaseLabel: pausedRounds > 0 ? `Paused · ${pausedRounds} rounds left` : plan?.message ?? this.phase?.snapshot().phaseLabel ?? `Step ${this.step + 1} of ${this.bets.length}`, roundIndex: this.played, observedRounds: this.rounds, lastBust: this.lastBust, currentBet: plan ? plan.nextAmount : next?.amount ?? null, cycle: this.cycle, stopReason: this.stopReason, pausedRounds, ...(plan ? { plan } : {}) };
  }
}
