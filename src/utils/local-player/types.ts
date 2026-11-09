// Generated from pakakumi-fully-local-player/src/types.ts by sync-local-player-engine.mjs.
export interface AccountCredentials {
  id: string;
  label: string;
  phone: string;
  password: string;
}

export interface PublicAccount {
  id: string;
  label: string;
  phone: string;
}

export interface StrategySettings {
  initialCapital: number;
  cycleBudget: number;
  baseBet: number;
  baseTarget: number;
  targetReturn: number;
  maxBet: number;
  boostBet: number;
  boostRounds: number;
  stageRounds: number[];
  profitFundedBoost?: boolean;
}

export interface RunSettings {
  initialCapital: number;
  maxBet: number;
  mode: "practice" | "live";
  strategy: import("./strategy/core.js").StrategyConfig;
  strategyName?: string;
  practiceResults?: number[];
  practiceDelayMs?: number;
  practiceSource?: "public" | "examples";
  replayRunId?: string;
}

export interface SavedStrategy {
  id: string;
  name: string;
  config: import("./strategy/core.js").StrategyConfig;
  defaultFunds?: number;
  defaultMaxAmount?: number;
}

export interface PendingBet {
  id: string;
  accountKey: string;
  accountLabel: string;
  sessionId: string;
  amount: number;
  cashout: number;
  gameId: string | null;
  capitalBefore: number;
  createdAt: string;
}

export type SessionStatus = "starting" | "active" | "stopping" | "stopped" | "failed" | "review";

export interface SessionSnapshot {
  id: string;
  accountLabel?: string;
  status: SessionStatus;
  running: boolean;
  currentCapital: number;
  totalProfit: number;
  phaseLabel: string;
  roundIndex: number;
  lastBust: number | null;
  currentBet: number | null;
  logs: string[];
  mode?: "practice" | "live";
  practiceSource?: "public" | "examples";
  sourceStatus?: "connecting" | "connected" | "reconnecting" | "stopped" | "unavailable";
  sourceDiagnostics?: { interruptions: number; recoveries: number; recoveredRounds: number; lastInterruptedAt: string | null };
  lastSourceRoundAt?: string | null;
  simulatedEntry?: { amount: number; cashout: number } | null;
  strategyName?: string;
  availableCapital?: number;
  accountBalance?: number | null;
  balanceCheckedAt?: string | null;
  pendingBet?: PendingBet | null;
  stopReason?: string | null;
  observedRounds?: number;
  cycle?: number;
  plan?: import("./strategy/adaptive.js").PlanView;
  pausedRounds?: number;
  initialCapital?: number;
  highestCapital?: number;
  lowestCapital?: number;
  maxDrawdown?: number;
  smallestAmount?: number | null;
  largestAmount?: number | null;
  replayRunId?: string;
  pendingResult?: boolean;
  capitalTrail?: number[];
  clockStartedAt?: number;
}

export type RunEvent = { type: "round"; ordinal: number; bust: number; time: number; capital: number } |
  { type: "result"; ordinal: number | null; played: number; bust: number | null; time: number; amount: number; target: number; payout: number; capital: number; reviewed?: boolean };
export interface ReplayData { results: number[]; times: number[]; startedAt: number }
export interface HistorySummary {
  id: string; startedAt: string; endedAt: string | null; state: string; name: string; mode: string; source: string;
  parentId: string | null; snapshot: SessionSnapshot; roundCount: number;
}
export const historyRoundFilters = ["all", "played", "win", "loss", "even", "observed"] as const;
export type HistoryRoundFilter = typeof historyRoundFilters[number];
export interface HistoryRound { seq: number; ordinal: number | null; time: number; bust: number | null; capital: number; amount: number | null; target: number | null; payout: number | null; net: number | null; reviewed: number; outcome: Exclude<HistoryRoundFilter,"all"|"played"> }
export interface HistoryTotals { played: number; win: number; loss: number; even: number; observed: number; totalPlayed: number; totalPaid: number; profitOnWins: number; lostOnLosses: number; largestWin: number; largestLoss: number }
export interface HistoryDetail { run: HistorySummary & { settings: RunSettings | null }; rounds: HistoryRound[]; stats: HistoryTotals; total: number; page: number; pages: number; chart: Array<{ seq: number; capital: number }> }

export interface AppState {
  accounts: PublicAccount[];
  selectedAccountId: string | null;
  session: SessionSnapshot | null;
  strategies?: SavedStrategy[];
  pending?: PendingBet[];
  historyError?: string | null;
}
