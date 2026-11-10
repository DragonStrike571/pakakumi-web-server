// Generated from pakakumi-fully-local-player/src/strategy/engine.ts by sync-local-player-engine.mjs.
import type { SessionSnapshot, StrategySettings } from "../types.js";

interface Bet {
  amount: number;
  cashout: number;
}

interface BasePhase {
  kind: "base";
  bets: Bet[];
  step: number;
  cycle: number;
  netProfit: number;
}

interface FixedPhase {
  kind: "boost" | "profit" | "rollover";
  betAmount: number;
  cashout: number;
  targetRounds: number;
  roundsPlayed: number;
  netProfit: number;
  stageNumber?: number;
}

type Phase = BasePhase | FixedPhase;

export interface SettledRound {
  won: boolean;
  netProfit: number;
  events: string[];
  phaseLabel: string;
}

export class StrategyEngine {
  private readonly settings: StrategySettings;
  private currentCapital: number;
  private totalProfit = 0;
  private roundIndex = 0;
  private lastBust: number | null = null;
  private baseCycle = 1;
  private phase: Phase;
  private baseBets: Bet[] | null = null;

  constructor(settings: StrategySettings) {
    this.settings = settings;
    this.currentCapital = settings.initialCapital;
    this.phase = this.makeBasePhase(this.baseCycle);
  }

  nextBet(): Bet {
    if (this.phase.kind === "base") {
      const bet = this.phase.bets[this.phase.step];
      if (!bet) throw new Error("Base cycle has no next bet");
      return bet;
    }
    return { amount: this.phase.betAmount, cashout: this.phase.cashout };
  }

  settleRound(bust: number, placedBet: Bet, grossPayout?: number): SettledRound {
    if (grossPayout !== undefined && (!Number.isFinite(grossPayout) || grossPayout < 0)) {
      throw new Error("Invalid recorded payout");
    }
    const won = grossPayout === undefined ? bust >= placedBet.cashout :
      grossPayout > 0 && grossPayout >= placedBet.amount * placedBet.cashout - 0.01;
    const netProfit = grossPayout === undefined ? (won ? placedBet.amount * (placedBet.cashout - 1) : -placedBet.amount) :
      Math.round((grossPayout - placedBet.amount) * 100) / 100;
    this.currentCapital += netProfit;
    this.totalProfit += netProfit;
    this.roundIndex++;
    this.lastBust = bust;

    const events: string[] = [];
    if (this.phase.kind === "base") {
      this.phase.netProfit += netProfit;
      this.phase.step++;
      if (won) {
        let boostAmount = this.settings.boostBet;
        if (this.settings.profitFundedBoost) {
          boostAmount = Math.min(boostAmount, Math.floor(Math.max(0, this.phase.netProfit) * 100 / this.settings.boostRounds + 1e-8) / 100);
          if (boostAmount < this.settings.baseBet) {
            events.push("The completed cycle cannot fund the next phase. Starting a new base cycle.");
            this.phase = this.makeBasePhase(++this.baseCycle);
            return { won, netProfit, events, phaseLabel: this.phaseLabel() };
          }
        }
        events.push(`Base target reached. Next phase: up to ${this.settings.boostRounds} rounds at ${boostAmount} KES.`);
        this.phase = {
          kind: "boost",
          betAmount: boostAmount,
          cashout: this.settings.baseTarget,
          targetRounds: this.settings.boostRounds,
          roundsPlayed: 0,
          netProfit: 0,
        };
      } else if (this.phase.step >= this.phase.bets.length) {
        events.push(`Base cycle completed without reaching the target. Next cycle allocation: ${this.settings.cycleBudget} KES.`);
        this.baseCycle++;
        this.phase = this.makeBasePhase(this.baseCycle);
      }
    } else {
      this.phase.roundsPlayed++;
      this.phase.netProfit += netProfit;
      if (won) {
        const realizedProfit = this.phase.netProfit;
        if (this.phase.kind === "boost") {
          this.startProfitStage(0, realizedProfit, events);
        } else if (this.phase.kind === "profit") {
          const nextIndex = (this.phase.stageNumber ?? 0) + 1;
          if (nextIndex < this.settings.stageRounds.length) {
            this.startProfitStage(nextIndex, realizedProfit, events);
          } else {
            this.startRolloverStage(realizedProfit, this.phase.targetRounds, events);
          }
        } else {
          this.startProfitStage(0, realizedProfit, events);
        }
      } else if (this.phase.roundsPlayed >= this.phase.targetRounds) {
        events.push(`Phase ended without reaching ${this.phase.cashout}x. Returning to the base cycle.`);
        this.baseCycle++;
        this.phase = this.makeBasePhase(this.baseCycle);
      }
    }

    return {
      won,
      netProfit,
      events,
      phaseLabel: this.phaseLabel(),
    };
  }

  snapshot(): Pick<SessionSnapshot, "currentCapital" | "totalProfit" | "phaseLabel" | "roundIndex" | "lastBust" | "currentBet"> {
    let currentBet: number | null = null;
    if (this.phase.kind === "base") {
      currentBet = this.phase.bets[this.phase.step]?.amount ?? null;
    } else {
      currentBet = this.phase.betAmount;
    }
    return {
      currentCapital: this.currentCapital,
      totalProfit: this.totalProfit,
      phaseLabel: this.phaseLabel(),
      roundIndex: this.roundIndex,
      lastBust: this.lastBust,
      currentBet,
    };
  }

  private makeBasePhase(cycle: number): BasePhase {
    return {
      kind: "base",
      bets: this.baseBets ??= generateAlgorithmBets(
        this.settings.cycleBudget,
        this.settings.baseBet,
        this.settings.baseTarget,
        this.settings.targetReturn,
        this.settings.maxBet,
      ),
      step: 0,
      cycle,
      netProfit: 0,
    };
  }

  cycleCount() { return this.baseCycle; }

  firstAmount() { return this.baseBets![0]!.amount; }

  reset() { this.phase = this.makeBasePhase(++this.baseCycle); }

  private startProfitStage(stageNumber: number, priorNetProfit: number, events: string[]) {
    const targetRounds = this.settings.stageRounds[stageNumber];
    if (!targetRounds) throw new Error(`Missing profit stage ${stageNumber + 1}`);
    const allocation = Math.max(0, priorNetProfit * 0.5);
    const perRound = this.fundedProfitStake(allocation, targetRounds, events);
    if (perRound === null) return;
    const atRisk = perRound * targetRounds;
    events.push(`Next phase: up to ${targetRounds} rounds at ${perRound.toFixed(2)} KES. Allocation: ${atRisk.toFixed(2)} KES from half the previous phase's profit.`);
    this.phase = {
      kind: "profit",
      betAmount: perRound,
      cashout: this.settings.baseTarget,
      targetRounds,
      roundsPlayed: 0,
      netProfit: 0,
      stageNumber,
    };
  }

  private startRolloverStage(priorNetProfit: number, completedRounds: number, events: string[]) {
    const targetRounds = this.settings.boostRounds;
    const allocation = Math.max(0, priorNetProfit * 0.5);
    const perRound = this.fundedProfitStake(allocation, targetRounds, events);
    if (perRound === null) return;
    const atRisk = perRound * targetRounds;
    events.push(`${completedRounds}-round phase completed. Next: up to ${targetRounds} rounds at ${perRound.toFixed(2)} KES, targeting ${this.settings.baseTarget}x. Allocation: ${atRisk.toFixed(2)} KES.`);
    this.phase = {
      kind: "rollover",
      betAmount: perRound,
      cashout: this.settings.baseTarget,
      targetRounds,
      roundsPlayed: 0,
      netProfit: 0,
    };
  }

  private fundedProfitStake(allocation: number, targetRounds: number, events: string[]) {
    const perRound = Math.min(this.settings.maxBet, Math.floor(allocation * 100 / targetRounds + 1e-8) / 100);
    if (perRound >= this.settings.baseBet) return perRound;
    events.push(`Half the phase profit (${allocation.toFixed(2)} KES) cannot fund ${targetRounds} minimum amounts. Returning to the base cycle.`);
    this.baseCycle++;
    this.phase = this.makeBasePhase(this.baseCycle);
    return null;
  }

  private phaseLabel() {
    if (this.phase.kind === "base") {
      const next = Math.min(this.phase.step + 1, this.phase.bets.length);
      return `Base algorithm · cycle ${this.phase.cycle} · step ${next}/${this.phase.bets.length}`;
    }
    const title = this.phase.kind === "boost"
      ? `Second phase`
      : this.phase.kind === "rollover"
        ? `Repeat phase`
        : `${this.phase.targetRounds}-round profit stage`;
    return `${title} · step ${this.phase.roundsPlayed + 1}/${this.phase.targetRounds} · ${this.phase.betAmount.toFixed(2)} KES`;
  }
}

/** Mirrors the existing algorithm's cumulative stake target and round-up rules. */
export function generateAlgorithmBets(
  capital: number,
  minimumBet: number,
  multiplier: number,
  targetReturn: number,
  maximumBet: number,
): Bet[] {
  let currentAmount = minimumBet;
  let totalSum = 0;
  const bets: Bet[] = [];
  let loops = 0;

  while (loops++ < 10_000) {
    let amount = Math.ceil(currentAmount * 100) / 100;
    if (amount > maximumBet || totalSum + amount > capital) break;
    amount = Math.max(minimumBet, amount);
    totalSum += amount;
    bets.push({ amount, cashout: multiplier });

    const nextRequired = (targetReturn * totalSum) / multiplier;
    if (nextRequired > currentAmount) currentAmount = nextRequired;
    currentAmount = Math.ceil(currentAmount * 100) / 100;
    if (!Number.isFinite(currentAmount)) break;
  }

  if (bets.length === 0) throw new Error("The cycle allocation cannot cover the minimum amount");
  return bets;
}
