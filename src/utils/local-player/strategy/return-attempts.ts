// Generated from pakakumi-fully-local-player/src/strategy/return-attempts.ts by sync-local-player-engine.mjs.
import type { AdaptiveConfig, PlanView } from "./adaptive.js";

export interface AttemptOutcome {
  action: "restart" | "advance" | "repeat" | "finish" | "stop";
  timing: "immediate" | "trigger";
  pauseRounds: number;
}
export interface ReturnAttemptsConfig {
  increases: Array<{ type: "multiply" | "add-base" | "add-budget"; value: number; times: number }>;
  afterIncreases: "last" | "repeat" | "hold";
  afterMiss: AttemptOutcome;
  afterHit: AttemptOutcome;
  resetOnHit: boolean;
  onBlocked?: "stop" | "restart";
  profitFloor?: { amount: number; scope: "since-hit" | "session" };
}
const cents = (n: number) => Math.round(n * 100) / 100;
const up = (n: number) => Math.ceil(n * 100 - 1e-7) / 100;

/** A rounded template is scaled as a whole; outcome policies apply to complete attempts. */
export class ReturnAttempts {
  cycle = 1;
  stopReason: string | null = null;
  stepIndex = 0;
  private scale = 1;
  private stage = 0;
  private stageUses = 0;
  private spent = 0;
  private hit = false;
  private waiting: boolean;
  private paused = 0;
  private losses = 0;
  private floorActive = false;
  private capital: number;
  private checkedFunding = false;
  private blockedByFunding = false;
  private readonly policy: ReturnAttemptsConfig;
  constructor(private c: AdaptiveConfig, private initial: number, private template: Array<{ amount: number; cashout: number }>) {
    this.policy = c.attempts!;
    this.waiting = c.start === "after-target";
    this.capital = initial;
    if (!template.length) this.stopReason = "The first attempt has no playable amounts.";
  }
  get budget() { return cents(this.c.cycleBudget * this.scale); }
  observe(bust: number) {
    if (this.paused > 0) { this.paused--; return false; }
    if (this.waiting && bust >= this.c.trigger) { this.waiting = false; return true; }
    return false;
  }
  private amountAt(step: number, loss: number, active: boolean) {
    const normal = cents((this.template[step]?.amount ?? 0) * this.scale);
    const floor = this.policy.profitFloor;
    if (!floor || normal <= 0) return { amount: normal, active };
    active ||= normal * (this.c.target - 1) - loss >= floor.amount - 1e-7;
    return { amount: active ? Math.max(this.c.minimum, up((loss + floor.amount) / (this.c.target - 1))) : normal, active };
  }
  private lossBasis(capital: number) { return this.policy.profitFloor?.scope === "session" ? this.initial - capital : this.losses; }
  private funding(capital: number) {
    let loss = this.lossBasis(capital), active = this.floorActive, total = 0;
    for (let i = this.stepIndex; i < this.template.length; i++) {
      const next = this.amountAt(i, loss, active);
      if (total + this.spent + next.amount > this.budget + 1e-7) break;
      if (next.amount < this.c.minimum || next.amount > this.c.maximum) return Infinity;
      total = cents(total + next.amount); loss = cents(loss + next.amount); active = next.active;
    }
    return total;
  }
  next(capital: number, usable: number, useRemaining: boolean): { amount: number; cashout: number } | null {
    this.capital = capital;
    if (this.stopReason || this.waiting || this.paused > 0) return null;
    for (let retry = 0; retry < 2; retry++) {
      if (this.stepIndex >= this.template.length) {
        this.complete(this.hit); if (this.stopReason || this.waiting || this.paused > 0) return null;
      }
      const next = this.amountAt(this.stepIndex, this.lossBasis(capital), this.floorActive);
      let amount = next.amount;
      if (!amount || this.spent + amount > this.budget + 1e-7) {
        if (!this.spent) { this.stopReason = "This attempt's first amount cannot fit its budget."; return null; }
        this.complete(this.hit); if (this.stopReason || this.waiting || this.paused > 0) return null;
        continue;
      }
      if (amount < this.c.minimum || amount > this.c.maximum) {
        this.blockedByFunding = true; this.stopReason = `This attempt needs an amount outside KES ${this.c.minimum}–${this.c.maximum}.`; return null;
      }
      if (!useRemaining && !this.checkedFunding) {
        const needed = this.funding(capital);
        if (!Number.isFinite(needed)) { this.blockedByFunding = true; this.stopReason = `This attempt contains an amount above the KES ${this.c.maximum} per-round limit.`; return null; }
        if (needed > usable + 1e-7) { this.blockedByFunding = true; this.stopReason = `Attempt ${this.cycle} needs KES ${needed.toFixed(2)} for its full schedule; only KES ${usable.toFixed(2)} is available.`; return null; }
        this.checkedFunding = true;
      }
      if (useRemaining) amount = Math.min(amount, Math.floor(usable * 100 + 1e-7) / 100);
      if (amount < this.c.minimum || amount > usable + 1e-7) { this.blockedByFunding = true; this.stopReason = "Available funds cannot cover the next amount. Protected funds are kept aside."; return null; }
      // Commit the profit switch only after a submitted result, never on a status read.
      return { amount, cashout: this.c.target };
    }
    return null;
  }
  private increase() {
    const rows = this.policy.increases;
    const row = rows[this.stage];
    if (!row) return;
    this.scale = row.type === "multiply" ? this.scale * row.value :
      this.scale + row.value / (row.type === "add-base" ? this.c.baseAmount : this.c.cycleBudget);
    if (++this.stageUses >= row.times) {
      this.stageUses = 0;
      if (this.stage < rows.length - 1) this.stage++;
      else if (this.policy.afterIncreases === "repeat") this.stage = 0;
      else if (this.policy.afterIncreases === "hold") this.stage = rows.length;
    }
    if (!Number.isFinite(this.scale) || this.budget > 1e9) this.stopReason = "The next attempt's budget exceeds the supported limit.";
  }
  private original() { this.scale = 1; this.stage = 0; this.stageUses = 0; this.floorActive = false; }
  private timing(outcome: AttemptOutcome) { this.waiting = outcome.timing === "trigger"; this.paused = outcome.pauseRounds; }
  private complete(success: boolean, override?: AttemptOutcome) {
    const outcome = override ?? (success ? this.policy.afterHit : this.policy.afterMiss);
    if (outcome.action === "stop") { this.stopReason = success ? "Target reached. Stopped as configured." : "Attempt ended without a hit. Stopped as configured."; return; }
    if (success && this.policy.resetOnHit) this.original();
    else if (!success && outcome.action === "advance") this.increase();
    this.cycle++; this.stepIndex = 0; this.spent = 0; this.hit = false; this.checkedFunding = false;
    this.timing(outcome);
  }
  settle(amount: number, payout: number, capital: number, action: string) {
    const won = payout >= amount * this.c.target - 0.01 && payout > 0;
    this.floorActive = this.amountAt(this.stepIndex, this.lossBasis(this.capital), this.floorActive).active;
    this.capital = capital;
    this.losses = won ? 0 : Math.max(0, cents(this.losses + amount - payout));
    this.spent = cents(this.spent + amount); this.stepIndex++; this.hit ||= won;
    const previous = this.cycle, success = this.hit;
    if (action === "strategy" && won) {
      if (this.policy.afterHit.action === "finish") {
        if (this.stepIndex < this.template.length) this.timing(this.policy.afterHit);
        else this.complete(true);
      } else this.complete(true);
    } else if (this.stepIndex >= this.template.length && action !== "reset" && action !== "jump") this.complete(this.hit,
      action === "strategy" ? undefined : { action: success ? "restart" : "repeat", timing: "immediate", pauseRounds: 0 });
    return this.stopReason ? [this.stopReason] : this.cycle !== previous ? [`Attempt ${previous} ${success ? "finished with a hit" : "missed"}. Attempt ${this.cycle}: budget KES ${this.budget.toFixed(2)}, scale ${Number(this.scale.toFixed(6))}×.`] : [];
  }
  reset() { this.original(); this.cycle++; this.stepIndex = 0; this.spent = 0; this.hit = false; this.checkedFunding = false; this.waiting = this.c.start === "after-target"; this.paused = 0; }
  restartBlocked(usable: number, lossRoom: number, amount: number | undefined, fallback: boolean) {
    if (!(this.policy.onBlocked === "restart" || this.policy.onBlocked === undefined && fallback) || this.stopReason && !this.blockedByFunding || this.scale === 1 && this.spent === 0) return false;
    const first = this.template[0]?.amount ?? Infinity, total = cents(this.template.reduce((sum,row)=>sum+row.amount,0));
    if (total > usable + 1e-7 || first > lossRoom + 1e-7 || amount !== undefined && first >= amount) return false;
    this.stopReason = null; this.blockedByFunding = false; this.reset(); return true;
  }
  resume() { this.waiting = false; this.paused = 0; }
  jumpTo(step: number) { this.stepIndex = Math.min(step, this.template.length - 1); this.checkedFunding = false; }
  canUse(amount: number, usable: number) { return !this.stopReason && !this.waiting && this.paused === 0 && amount <= usable + 1e-7 && this.spent + amount <= this.budget + 1e-7; }
  view(capital: number, usable: number): PlanView {
    const amount = this.amountAt(this.stepIndex, this.lossBasis(capital), this.floorActive).amount;
    const state = this.stopReason ? "stopped" : this.waiting || this.paused > 0 ? "waiting" : "ready";
    return { state, message: this.stopReason ?? (this.paused > 0 ? `Wait ${this.paused} more rounds${this.waiting ? `, then wait for ${this.c.trigger}x` : ""}.` : this.waiting ? `Attempt ${this.cycle}: waiting for ${this.c.trigger}x or higher.` : `Attempt ${this.cycle} · step ${this.stepIndex + 1}/${this.template.length} · KES ${amount.toFixed(2)} at ${this.c.target}x.`),
      target: this.c.target, nextAmount: state === "ready" ? amount : null, indicativeAmount: amount,
      protectedAmount: cents(capital - usable), usableFunds: usable, windowBudget: this.budget,
      roundsRemaining: this.template.length - this.stepIndex, roundLimit: this.template.length, windowNumber: this.cycle,
      spent: this.spent, baseAmount: cents(this.c.baseAmount * this.scale), pausedRounds: this.paused,
      attemptScale: this.scale, attemptBudget: this.budget, attemptStep: this.stepIndex + 1,
      profitNote: this.floorActive ? `Sizing for KES ${this.policy.profitFloor!.amount} net profit after earlier losses.` : null };
  }
}
