// Generated from pakakumi-fully-local-player/src/strategy/adaptive.ts by sync-local-player-engine.mjs.
import { generateAlgorithmBets } from "./core.js";
import { ReturnAttempts, type ReturnAttemptsConfig } from "./return-attempts.js";

export type AmountRounding = "cents" | "nearest-whole" | "up-whole" | "down-whole" | "nearest-five" | "up-five" | "down-five" | "nearest-ten" | "up-ten";
export interface BudgetProgression { type: "fixed" | "multiply" | "add" | "budgets" | "increments"; value: number; values: number[]; repeat: boolean }
export interface AdaptiveConfig {
  kind: "compound" | "roi" | "window";
  target: number;
  minimum: number;
  maximum: number;
  rounding: AmountRounding;
  start: "now" | "after-target";
  trigger: number;
  afterHit: "continue" | "wait" | "stop" | "restart-window";
  fractionBasis: "current" | "initial" | "available";
  fractionPercent?: number;
  baseAmount: number;
  baseAfterMiss?: { type: "add" | "multiply"; value: number; every: number; resetOnHit: boolean };
  returnMode: "multiple" | "profit";
  returnCalculation?: "website" | "cycle";
  calculationTarget?: number;
  attempts?: ReturnAttemptsConfig;
  returnMultiple: number;
  goalProfit: number;
  adjustBeforeRound: boolean;
  resetSpentOnHit: boolean;
  cycleBudget: number;
  cycleEnd: "restart" | "wait" | "stop";
  factor: number;
  windowRounds: number;
  roundsMode: "factor" | "fixed";
  windowEnabled: boolean;
  windowAfter: "wait" | "repeat" | "stop";
  resetSpentAfterWindow: boolean;
  windowBudget: number;
  progression: BudgetProgression;
  windowProfitGoal?: number;
  hitBudget: "reset" | "keep" | "advance";
  protection?: { profit: number; keepInitial: boolean; maxUsePercent: number; raiseOnWin: boolean };
}
export interface PlanView {
  state: "waiting" | "ready" | "stopped";
  message: string;
  target: number;
  nextAmount: number | null;
  indicativeAmount: number;
  protectedAmount: number;
  usableFunds: number;
  windowBudget: number | null;
  roundsRemaining: number | null;
  roundLimit: number | null;
  windowNumber: number;
  spent: number;
  roundingNote?: string | null;
  profitNote?: string | null;
  baseAmount?: number;
  pausedRounds?: number;
  attemptScale?: number;
  attemptBudget?: number;
  attemptStep?: number;
}
const cents = (n: number) => Math.round(n * 100) / 100;
const down = (n: number) => Math.floor(n * 100 + 1e-7) / 100;
export function roundAmount(n: number, rounding: AmountRounding) {
  switch (rounding) {
    case "nearest-whole": return Math.round(n);
    case "up-whole": return Math.ceil(n - 1e-10);
    case "down-whole": return Math.floor(n + 1e-10);
    case "nearest-five": return Math.round(n / 5) * 5;
    case "up-five": return Math.ceil(n / 5 - 1e-10) * 5;
    case "down-five": return Math.floor(n / 5 + 1e-10) * 5;
    case "nearest-ten": return Math.round(n / 10) * 10;
    case "up-ten": return Math.ceil(n / 10 - 1e-10) * 10;
    default: return cents(n);
  }
}

/** Keep equal window amounts inside their allocation, including fractional
 * allocations produced by progression. Never raise the allocation to round up. */
export function windowAmount(budget: number, rounds: number, minimum: number, maximum: number, rounding: AmountRounding) {
  const limit = Math.floor(Math.floor(budget * 100 + 1e-7) / rounds + 1e-7) / 100;
  const requested = Math.min(maximum, Math.max(minimum, rounding === "cents" ? limit : roundAmount(budget / rounds, rounding)));
  if (limit < minimum) return { amount: 0, requested, adjusted: false };
  const unit = rounding === "cents" ? 1 : rounding.includes("five") ? 500 : rounding.includes("ten") ? 1000 : 100;
  const fitting = Math.floor((Math.round(limit * 100) + 1e-7) / unit) * unit / 100;
  const amount = cents(requested <= limit + 1e-7 ? requested : Math.max(minimum, fitting));
  return { amount, requested, adjusted: amount < requested - 1e-7 };
}

/** Dynamic amount and market-trigger policies; no history scans or I/O. */
export class AdaptivePlan {
  cycle = 1;
  stopReason: string | null = null;
  private blockedByAmount = false;
  private waiting: boolean;
  private seen = 0;
  private openedAt: number | null = null;
  private armedAfter = 0;
  private windowEnding = false;
  private windowWon = false;
  private spent = 0;
  private budget: number;
  private budgetIndex = 0;
  private lossSinceHit = 0;
  private openingLoss = 0;
  private sizingForProfit = false;
  private protectedAmount = 0;
  private protectionActive = false;
  private currentBase: number;
  private missesSinceIncrease = 0;
  private calculatedBets: Array<{ amount: number; cashout: number }> = [];
  private calculatedBase: number;
  private calculatedStep = 0;
  private attempts?: ReturnAttempts;
  constructor(readonly config: AdaptiveConfig, private initial: number, private restartOnBlocked = false) {
    this.waiting = config.start === "after-target";
    this.budget = config.windowBudget;
    this.currentBase = config.baseAmount;
    this.calculatedBase = config.baseAmount;
    this.buildCalculation();
    if (config.attempts) this.attempts = new ReturnAttempts(config, initial, this.calculatedBets);
  }
  get stepIndex() { return this.attempts?.stepIndex ?? this.calculatedStep; }
  private syncAttempts() { this.cycle = this.attempts!.cycle; this.stopReason = this.attempts!.stopReason; }
  private buildCalculation() {
    const c = this.config;
    if (c.kind !== "roi" || c.returnCalculation !== "website") return;
    this.calculatedBase = this.currentBase;
    this.calculatedBets = generateAlgorithmBets(c.cycleBudget, this.currentBase, c.calculationTarget ?? c.target,
      c.returnMultiple, undefined, c.maximum, c.baseAfterMiss, amount => Math.max(c.minimum, roundAmount(amount, c.rounding)));
  }
  jumpTo(step: number) {
    if (this.attempts) { this.attempts.jumpTo(step); this.syncAttempts(); return; }
    if (this.config.returnCalculation !== "website" || !this.calculatedBets.length) return;
    const next = Math.min(step, this.calculatedBets.length - 1);
    if (next === 0 && this.calculatedStep !== 0) this.cycle++;
    this.calculatedStep = next;
  }
  observe(bust: number) {
    if (this.attempts) return this.attempts.observe(bust);
    this.seen++;
    if (this.waiting) {
      if (this.seen > this.armedAfter && bust >= this.config.trigger) { this.openWindow(); return true; }
    } else if (this.config.windowEnabled && this.openedAt !== null && this.seen - this.openedAt >= this.config.windowRounds) this.windowEnding = true;
    return false;
  }
  private openWindow() { this.waiting = false; this.openedAt = this.seen; this.windowEnding = false; this.windowWon = false; this.openingLoss = this.lossSinceHit; if (this.config.kind === "window") this.spent = 0; }
  private wait() { this.waiting = true; this.armedAfter = this.seen; this.windowEnding = false; }
  private protect(capital: number, won = false) {
    const p = this.config.protection;
    if (!p) return;
    if (!this.protectionActive && capital - this.initial >= p.profit - 1e-7) {
      this.protectionActive = true;
      this.protectedAmount = Math.max((p.keepInitial ? this.initial : 0) + p.profit, capital * (1 - p.maxUsePercent / 100));
    } else if (this.protectionActive && won && p.raiseOnWin) this.protectedAmount = Math.max(this.protectedAmount, capital * (1 - p.maxUsePercent / 100));
    this.protectedAmount = cents(this.protectedAmount);
  }
  usable(capital: number) {
    const remaining = Math.max(0, cents(capital - this.protectedAmount));
    return this.protectionActive ? Math.min(remaining, down(capital * this.config.protection!.maxUsePercent / 100)) : remaining;
  }
  private amount(capital: number, spent = this.spent, maximum = this.config.maximum, base = this.currentBase) {
    const c = this.config;
    if (c.kind === "window") return this.sizingForProfit ? cents(this.budget / c.windowRounds) : windowAmount(this.budget, c.windowRounds, c.minimum, c.maximum, c.rounding).amount;
    let raw: number;
    if (c.kind === "compound") {
      const basis = c.fractionBasis === "initial" ? this.initial : c.fractionBasis === "available" ? this.usable(capital) : capital;
      raw = basis * (c.fractionPercent === undefined ? 1 / c.target : c.fractionPercent / 100);
    } else if (c.kind === "roi") {
      if (c.returnCalculation === "website") return this.calculatedBets[this.calculatedStep]?.amount ?? Infinity;
      const target = c.calculationTarget ?? c.target;
      raw = c.returnMode === "profit" ? (spent + c.goalProfit) / (target - (c.adjustBeforeRound ? 1 : 0)) : spent * c.returnMultiple / (target - (c.adjustBeforeRound ? c.returnMultiple : 0));
      raw = Math.max(base, raw);
    } else raw = this.budget / c.windowRounds;
    const amount = Math.min(maximum, Math.max(c.minimum, roundAmount(raw, c.rounding)));
    return cents(amount);
  }
  private windowExceedsMaximum() {
    const c = this.config;
    return this.restartOnBlocked && c.kind === "window" && this.budget > c.windowBudget && !this.sizingForProfit &&
      windowAmount(this.budget, c.windowRounds, c.minimum, Infinity, c.rounding).amount > c.maximum;
  }
  private blockMaximum() {
    return this.block(`The next amount exceeds the KES ${this.config.maximum.toFixed(2)} per-round limit.`);
  }
  next(capital: number, useRemaining = false) {
    this.protect(capital);
    if (this.attempts) { const bet = this.attempts.next(capital, this.usable(capital), useRemaining); this.syncAttempts(); return bet; }
    if (this.stopReason) return null;
    if (this.windowEnding) this.finishWindow();
    if (this.waiting || this.stopReason) return null;
    if (this.openedAt === null) this.openWindow();
    const c = this.config;
    if (this.windowExceedsMaximum()) return this.blockMaximum();
    const website = c.kind === "roi" && c.returnCalculation === "website";
    if (c.kind === "roi" && !website && this.currentBase > c.maximum + 1e-7) return this.blockMaximum();
    let amount = this.amount(capital);
    const overAllocation = this.spent + amount > c.cycleBudget + 1e-7 || website && this.calculatedStep >= this.calculatedBets.length;
    if (c.kind === "roi" && (overAllocation || website && amount > c.maximum)) {
      if (website && !this.spent) return this.block("The first amount cannot fit the cycle allocation or per-round limit.");
      this.currentBase = c.baseAmount; this.missesSinceIncrease = 0; this.clearReturnSpending(); this.cycle++;
      if (this.config.cycleEnd === "stop") { this.stopReason = "Cycle allocation used. Stopped as configured."; return null; }
      if (this.config.cycleEnd === "wait") { this.wait(); return null; }
      amount = this.amount(capital);
    }
    if (website && amount > c.maximum) return this.blockMaximum();
    if (this.restartOnBlocked && c.kind === "roi" && this.spent > 0 && this.amount(capital, this.spent, Infinity) > c.maximum) {
      return this.blockMaximum();
    }
    if (amount < this.config.minimum) return this.block(`This window has KES ${this.budget.toFixed(2)}. ${this.config.windowRounds} rounds need at least KES ${(this.config.minimum * this.config.windowRounds).toFixed(2)}.`);
    const remaining = this.config.windowRounds - (this.seen - (this.openedAt ?? this.seen));
    if (this.sizingForProfit && amount * Math.max(1, remaining) > this.usable(capital) + 1e-7) {
      return this.block("Available funds cannot cover the remaining rounds at the profit-target amount.");
    }
    if (!this.sizingForProfit && !useRemaining && this.config.kind === "window" && this.spent === 0 && amount * this.config.windowRounds > this.usable(capital) + 1e-7) return this.block("Available funds cannot cover this complete window.");
    if (useRemaining) { amount = Math.min(amount, down(this.usable(capital))); if (amount < this.config.minimum) { this.stopReason = "Playable funds are below the minimum amount. Protected funds are kept aside."; return null; } }
    if (amount > this.usable(capital) + 1e-7) return this.block(this.protectionActive ? "The next amount would use protected funds." : "Available funds cannot cover the next amount.");
    return { amount, cashout: this.config.target };
  }
  private block(reason: string) { this.blockedByAmount = true; this.stopReason = reason; return null; }
  restartBlocked(capital: number, lossRoom: number, amount?: number) {
    if (this.attempts) { const restarted = this.attempts.restartBlocked(this.usable(capital), lossRoom, amount, this.restartOnBlocked); this.syncAttempts(); return restarted; }
    if (!this.restartOnBlocked || (this.stopReason && !this.blockedByAmount)) return false;
    const c = this.config;
    const progressed = c.kind === "window" ? this.budget !== c.windowBudget || this.sizingForProfit : c.kind === "roi" && this.spent > 0;
    if (!progressed) return false;
    const firstReturnAmount = c.returnCalculation === "website" ? Math.max(c.minimum, roundAmount(c.baseAmount, c.rounding)) : this.amount(capital, 0, Infinity, c.baseAmount);
    if (c.kind === "roi" && firstReturnAmount > c.maximum) return false;
    const first = c.kind === "window" ? windowAmount(c.windowBudget, c.windowRounds, c.minimum, c.maximum, c.rounding).amount : firstReturnAmount;
    const required = c.kind === "window" ? first * c.windowRounds : first;
    if (first < c.minimum || required > this.usable(capital) + 1e-7 || first > lossRoom + 1e-7 || (amount !== undefined && first >= amount)) return false;
    this.reset(c.kind !== "window" || this.spent > 0);
    return true;
  }
  canUse(amount: number, capital: number) { return this.attempts ? this.attempts.canUse(amount, this.usable(capital)) : !this.waiting && !this.stopReason && !this.windowEnding && amount <= this.usable(capital) + 1e-7; }
  settle(amount: number, payout: number, capital: number, useRemaining = false, action = "strategy") {
    const c = this.config, won = payout >= amount * c.target - 0.01 && payout > 0;
    if (this.attempts) { this.protect(capital, won); const events = this.attempts.settle(amount, payout, capital, action); this.syncAttempts(); return events; }
    this.spent = cents(this.spent + amount); this.protect(capital, won);
    if (c.windowProfitGoal !== undefined) this.lossSinceHit = won ? 0 : cents(this.lossSinceHit + amount - payout);
    const events: string[] = [];
    if (c.kind === "roi" && c.baseAfterMiss) {
      const change = c.baseAfterMiss;
      if (won) {
        this.missesSinceIncrease = 0;
        if (change.resetOnHit) this.currentBase = c.baseAmount;
      } else if (++this.missesSinceIncrease >= change.every) {
        this.missesSinceIncrease = 0;
        this.currentBase = cents(change.type === "add" ? this.currentBase + change.value : this.currentBase * change.value);
        events.push(`Base amount for the next play is KES ${this.currentBase.toFixed(2)}.`);
      }
    }
    const website = c.kind === "roi" && c.returnCalculation === "website";
    if (website) this.calculatedStep++;
    if (won) {
      if (c.kind === "window") {
        this.windowWon = true;
        if (c.afterHit === "restart-window") { this.applyHitBudget(); this.cycle++; this.openWindow(); events.push("Target reached. A new window starts next round."); }
        else if (c.afterHit === "wait") { this.applyHitBudget(); this.cycle++; this.spent = 0; this.wait(); }
        else if (c.afterHit === "stop") this.stopReason = "Target reached. Stopped as configured.";
      } else if (!website || action === "strategy" || action === "pause") {
        if (c.kind === "roi" && c.resetSpentOnHit) { this.clearReturnSpending(); if (!c.windowEnabled) this.cycle++; }
        if (!website || action !== "pause") {
          if (c.afterHit === "restart-window" && c.windowEnabled) { this.cycle++; this.openWindow(); }
          else if (c.afterHit === "wait") { if (c.windowEnabled) this.cycle++; this.wait(); }
          else if (c.afterHit === "stop") this.stopReason = "Target reached. Stopped as configured.";
        }
      }
    }
    if (this.windowEnding && !this.stopReason) {
      this.finishWindow();
      if (this.restartOnBlocked && c.kind === "window" && c.windowAfter === "wait" && !this.windowWon && !this.stopReason &&
          (this.sizingForProfit || !useRemaining) && this.amount(capital) * c.windowRounds > this.usable(capital) + 1e-7) {
        this.block("Available funds cannot cover this complete window.");
      }
      events.push(this.stopReason ?? (this.waiting ? `Window complete. Waiting for ${c.trigger}x or higher.` : "Window complete. The next window starts next round."));
    }
    return events;
  }
  private advanceBudget() {
    const p = this.config.progression;
    this.budgetIndex++;
    if (p.type === "multiply") this.budget = cents(this.budget * p.value);
    else if (p.type === "add") this.budget = cents(this.budget + p.value);
    else if (p.type === "budgets") this.budget = p.values[p.repeat ? this.budgetIndex % p.values.length : Math.min(this.budgetIndex, p.values.length - 1)]!;
    else if (p.type === "increments") this.budget = cents(this.budget + p.values[p.repeat ? (this.budgetIndex - 1) % p.values.length : Math.min(this.budgetIndex - 1, p.values.length - 1)]!);
  }
  private checkBudget() {
    if (!Number.isFinite(this.budget) || this.budget > 1e12) this.stopReason = "The next window allocation is too large.";
  }
  private advanceMissedWindow() {
    const c = this.config, goal = c.windowProfitGoal;
    if (goal === undefined) {
      this.advanceBudget();
      if (!Number.isFinite(this.budget) || this.budget > 1e12) this.block("The next window allocation is too large.");
      else if (this.windowExceedsMaximum()) this.blockMaximum();
      return;
    }

    // Allow for a hit on the final round, after every earlier amount was lost.
    const margin = c.target - c.windowRounds;
    const reachesGoal = (loss: number) => windowAmount(this.budget, c.windowRounds, c.minimum, c.maximum, c.rounding).amount * margin - loss >= goal - 1e-7;
    this.sizingForProfit ||= reachesGoal(this.openingLoss);
    if (!this.sizingForProfit) {
      this.advanceBudget();
      this.sizingForProfit = reachesGoal(this.lossSinceHit);
    }
    if (this.sizingForProfit) {
      const raw = Math.max(c.minimum, (this.lossSinceHit + goal) / margin);
      const unit = c.rounding === "cents" ? 0.01 : c.rounding.includes("five") ? 5 : c.rounding.includes("ten") ? 10 : 1;
      const amount = Math.max(c.minimum, cents(Math.ceil(raw / unit - 1e-8) * unit));
      if (raw > c.maximum + 1e-7) {
        this.block(`The profit target needs more than the KES ${c.maximum.toFixed(2)} per-round limit.`);
        return;
      }
      this.budget = cents(Math.min(c.maximum, amount) * c.windowRounds);
    }
    this.checkBudget();
  }
  private applyHitBudget() {
    this.sizingForProfit = false;
    if (this.config.hitBudget === "reset") { this.budget = this.config.windowBudget; this.budgetIndex = 0; }
    else if (this.config.hitBudget === "advance") { this.advanceBudget(); this.checkBudget(); }
  }
  private finishWindow() {
    if (this.config.kind === "window") {
      if (this.windowWon) this.applyHitBudget();
      else this.advanceMissedWindow();
      this.spent = 0;
      if (this.config.windowAfter === "stop") this.blockedByAmount = false;
    }
    else if (this.config.resetSpentAfterWindow) this.clearReturnSpending();
    this.cycle++;
    if (this.config.windowAfter === "stop") { this.windowEnding = false; this.stopReason ??= "The play window is complete. Stopped as configured."; }
    else if (this.config.windowAfter === "repeat") this.openWindow();
    else this.wait();
  }
  reset(advanceCycle = true) {
    if (this.attempts) { this.attempts.reset(); this.syncAttempts(); return; }
    if (this.restartOnBlocked && this.blockedByAmount) { this.stopReason = null; this.blockedByAmount = false; }
    if (advanceCycle) this.cycle++;
    this.spent = 0;
    this.lossSinceHit = 0;
    this.sizingForProfit = false;
    this.budget = this.config.windowBudget;
    this.budgetIndex = 0;
    this.windowEnding = false;
    this.currentBase = this.config.baseAmount;
    this.missesSinceIncrease = 0;
    this.clearReturnSpending();
    if (this.config.start === "after-target") this.wait();
    else if (this.config.windowEnabled) this.openWindow();
    else this.waiting = false;
  }
  private clearReturnSpending() {
    this.spent = 0;
    this.calculatedStep = 0;
    if (this.calculatedBase !== this.currentBase) this.buildCalculation();
  }
  resume() { if (this.attempts) { this.attempts.resume(); return; } const wasWaiting = this.waiting; this.waiting = false; if (this.config.windowEnabled && wasWaiting) this.openWindow(); }
  view(capital: number): PlanView {
    if (this.attempts) return this.attempts.view(capital, this.usable(capital));
    const c = this.config, calculatedEnd = c.kind === "roi" && c.returnCalculation === "website" && this.calculatedStep >= this.calculatedBets.length;
    const amount = calculatedEnd ? Math.max(c.minimum, roundAmount(c.baseAmount, c.rounding)) : this.amount(capital);
    const remaining = c.windowEnabled ? Math.max(0, c.windowRounds - (this.seen - (this.openedAt ?? this.seen))) : null;
    const cycleNote = calculatedEnd ? c.cycleEnd === "restart" ? "Cycle complete. Starting over next round." : c.cycleEnd === "wait" ? "Cycle complete. Will wait for a fresh target." : "Cycle complete. Will stop before another play." : null;
    const sizing = c.kind === "window" && !this.sizingForProfit ? windowAmount(this.budget,c.windowRounds,c.minimum,c.maximum,c.rounding) : null;
    const roundingNote = sizing?.adjusted ? `Rounding adjusted to KES ${amount.toFixed(2)} per round to stay within this window's KES ${this.budget.toFixed(2)} allocation.` : null;
    const profitNote = this.sizingForProfit && !this.stopReason ? `Now sizing for KES ${c.windowProfitGoal!.toFixed(2)} net profit after earlier misses if the target hits.` : null;
    return {
      state: this.stopReason ? "stopped" : this.waiting ? "waiting" : "ready",
      message: this.stopReason ?? (this.waiting ? `Waiting for ${c.trigger}x or higher.` : cycleNote ?? (c.windowEnabled ? `${remaining} rounds left in this window.` : `Next amount: ${amount.toFixed(2)} KES at ${c.target}x.`)),
      target: c.target, nextAmount: this.waiting || this.stopReason || calculatedEnd ? null : amount, indicativeAmount: amount,
      protectedAmount: this.protectionActive ? cents(capital - this.usable(capital)) : 0, usableFunds: this.usable(capital),
      windowBudget: c.kind === "window" ? this.budget : null,
      roundsRemaining: this.waiting && c.windowEnabled ? c.windowRounds : remaining,
      roundLimit: c.windowEnabled ? c.windowRounds : null, windowNumber: this.cycle, spent: this.spent,
      ...(c.kind === "roi" ? { baseAmount: this.currentBase } : {}), roundingNote, profitNote,
    };
  }
}
