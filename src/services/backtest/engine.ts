import { generateAlgorithmBets, type StrategyConfig } from "../../utils/strategies/core.js";

export type BacktestOutcome = "win" | "loss";
export type OutcomeAction = "strategy" | "continue" | "reset" | "pause" | "stop";
export type RuleMetric =
  | "bust"
  | "capital"
  | "profit"
  | "drawdown"
  | "consecutiveWins"
  | "consecutiveLosses"
  | "roundsSinceWin"
  | "roundsSinceLoss"
  | "roundsSinceLast3000"
  | "totalReserveFunds"
  | "roundIndex";
export type RuleOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export interface BacktestRound {
  id: string;
  bust: number;
  createdAt: Date | string;
  roundsSinceLast3000?: number | null;
  totalReserveFunds?: number | null;
  gapDetected?: boolean;
  metricsComplete?: boolean;
}

export interface BacktestRule {
  id: string;
  event?: "any" | BacktestOutcome;
  match?: "all" | "any";
  conditions: Array<{
    metric: RuleMetric;
    operator: RuleOperator;
    value: number;
  }>;
  action: {
    type: "stop" | "pause" | "reset" | "continue" | "jump";
    rounds?: number;
    step?: number;
  };
  once?: boolean;
}

export interface BacktestScenario {
  afterWin?: { action: OutcomeAction; pauseRounds?: number };
  afterLoss?: { action: OutcomeAction; pauseRounds?: number };
  rules?: BacktestRule[];
  maxBets?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface BacktestLedgerEntry {
  roundId: string;
  roundIndex: number;
  createdAt: string;
  bust: number;
  amount: number;
  cashout: number;
  outcome: BacktestOutcome;
  pnl: number;
  capital: number;
  strategyStep: number;
  ruleId?: string;
}

export interface BacktestResult {
  summary: {
    startingCapital: number;
    endingCapital: number;
    netProfit: number;
    roiPercent: number;
    totalBets: number;
    wins: number;
    losses: number;
    winRatePercent: number;
    totalWagered: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number | null;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    longestWinStreak: number;
    longestLossStreak: number;
    roundsProcessed: number;
    roundsSkipped: number;
    stoppedEarly: boolean;
    stopReason: string | null;
  };
  equityCurve: Array<{ roundIndex: number; capital: number }>;
  ledger?: BacktestLedgerEntry[];
  warnings: string[];
}

function compare(left: number, operator: RuleOperator, right: number) {
  switch (operator) {
    case "eq": return left === right;
    case "neq": return left !== right;
    case "gt": return left > right;
    case "gte": return left >= right;
    case "lt": return left < right;
    case "lte": return left <= right;
  }
}

function sampleEquityCurve(
  points: Array<{ roundIndex: number; capital: number }>,
  maxPoints = 1_000,
) {
  if (points.length <= maxPoints) return points;
  const sampled = [points[0]!];
  const stride = (points.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) {
    sampled.push(points[Math.round(i * stride)]!);
  }
  sampled.push(points.at(-1)!);
  return sampled;
}

function resolveBets(config: StrategyConfig) {
  const bets = config.type === "algorithm" && config.algorithm
    ? generateAlgorithmBets(
        config.algorithm.capital,
        config.algorithm.minAmount,
        config.algorithm.multiplier,
        config.algorithm.targetReturn,
        config.algorithm.roundingOption,
        config.algorithm.maxPlayable,
      )
    : config.sequence?.bets ?? [];

  return config.autoCashout === undefined
    ? bets
    : bets.map((bet) => ({ ...bet, cashout: config.autoCashout! }));
}

export function runBacktest(input: {
  rounds: BacktestRound[];
  strategy: StrategyConfig;
  initialCapital: number;
  scenario?: BacktestScenario;
  includeLedger?: boolean;
}): BacktestResult {
  const { rounds, strategy, initialCapital } = input;
  const configuredScenario = strategy.execution ?? {};
  const requestedScenario = input.scenario ?? {};
  const resolveOutcomeDirective = (
    requested: BacktestScenario["afterWin"],
    configured: BacktestScenario["afterWin"],
  ) => !requested || requested.action === "strategy"
    ? configured ?? requested
    : requested;
  const scenario: BacktestScenario = {
    ...configuredScenario,
    ...requestedScenario,
    afterWin: resolveOutcomeDirective(
      requestedScenario.afterWin,
      configuredScenario.afterWin,
    ),
    afterLoss: resolveOutcomeDirective(
      requestedScenario.afterLoss,
      configuredScenario.afterLoss,
    ),
    rules: requestedScenario.rules ?? configuredScenario.rules,
  };
  const bets = resolveBets(strategy);
  const warnings: string[] = [];

  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new Error("Initial capital must be a positive finite number");
  }
  if (bets.length === 0) throw new Error("Strategy does not contain any bets");

  let capital = initialCapital;
  let step = 0;
  let pauseRemaining = 0;
  let totalBets = 0;
  let wins = 0;
  let losses = 0;
  let totalWagered = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let roundsSinceWin = 0;
  let roundsSinceLoss = 0;
  let roundsProcessed = 0;
  let roundsSkipped = 0;
  let stopReason: string | null = null;

  const firedOnceRules = new Set<string>();
  const equityCurve: Array<{ roundIndex: number; capital: number }> = [
    { roundIndex: 0, capital },
  ];
  const ledger: BacktestLedgerEntry[] = [];

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex++) {
    const round = rounds[roundIndex]!;
    roundsProcessed++;
    roundsSinceWin++;
    roundsSinceLoss++;

    if (pauseRemaining > 0) {
      pauseRemaining--;
      roundsSkipped++;
      continue;
    }

    const placedStep = step;
    const bet = bets[placedStep];
    if (!bet) {
      stopReason = `Strategy step ${step} does not exist`;
      break;
    }
    if (bet.amount > capital) {
      stopReason = "Insufficient capital for the next bet";
      break;
    }

    const outcome: BacktestOutcome = round.bust >= bet.cashout ? "win" : "loss";
    const pnl = outcome === "win" ? bet.amount * (bet.cashout - 1) : -bet.amount;
    capital = Math.round((capital + pnl) * 100) / 100;
    totalBets++;
    totalWagered += bet.amount;

    if (outcome === "win") {
      wins++;
      grossProfit += pnl;
      consecutiveWins++;
      consecutiveLosses = 0;
      roundsSinceWin = 0;
      longestWinStreak = Math.max(longestWinStreak, consecutiveWins);
    } else {
      losses++;
      grossLoss += Math.abs(pnl);
      consecutiveLosses++;
      consecutiveWins = 0;
      roundsSinceLoss = 0;
      longestLossStreak = Math.max(longestLossStreak, consecutiveLosses);
    }

    peakCapital = Math.max(peakCapital, capital);
    const drawdown = peakCapital - capital;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    maxDrawdownPercent = Math.max(
      maxDrawdownPercent,
      peakCapital > 0 ? (drawdown / peakCapital) * 100 : 0,
    );

    const strategyNextStep = outcome === "win"
      ? 0
      : step + 1 >= bets.length ? 0 : step + 1;
    const metrics: Record<RuleMetric, number | null> = {
      bust: round.bust,
      capital,
      profit: capital - initialCapital,
      drawdown,
      consecutiveWins,
      consecutiveLosses,
      roundsSinceWin,
      roundsSinceLoss,
      roundsSinceLast3000: round.roundsSinceLast3000 ?? null,
      totalReserveFunds: round.totalReserveFunds ?? null,
      // Execution-rule round numbers are one-based in the live bot and UI.
      // Ledger/equity indexes remain zero-based array positions.
      roundIndex: roundIndex + 1,
    };

    const matchedRule = scenario.rules?.find((rule) => {
      if (rule.once && firedOnceRules.has(rule.id)) return false;
      if (rule.event && rule.event !== "any" && rule.event !== outcome) return false;
      const matches = rule.conditions.map((condition) => {
        const metric = metrics[condition.metric];
        return metric !== null && compare(metric, condition.operator, condition.value);
      });
      return (rule.match ?? "all") === "all"
        ? matches.every(Boolean)
        : matches.some(Boolean);
    });

    const requestedAction = outcome === "win"
      ? scenario.afterWin
      : scenario.afterLoss;
    let ruleId: string | undefined;

    if (matchedRule) {
      if (matchedRule.once) firedOnceRules.add(matchedRule.id);
      ruleId = matchedRule.id;
      const action = matchedRule.action;
      if (action.type === "stop") stopReason = `Rule '${matchedRule.id}' stopped the run`;
      if (action.type === "pause") {
        pauseRemaining = Math.max(0, Math.floor(action.rounds ?? 0));
        step = action.step === undefined
          ? strategyNextStep
          : Math.min(Math.max(0, Math.floor(action.step)), bets.length - 1);
      } else if (action.type === "reset") step = 0;
      else if (action.type === "continue") step = (step + 1) % bets.length;
      else if (action.type === "jump") {
        step = Math.min(Math.max(0, Math.floor(action.step ?? 0)), bets.length - 1);
      }
    } else if (
      outcome === "win" &&
      strategy.stopAfterWin &&
      (!requestedAction || requestedAction.action === "strategy")
    ) {
      stopReason = "Strategy is configured to stop after a win";
    } else if (requestedAction?.action === "stop") {
      stopReason = `Configured to stop after a ${outcome}`;
    } else if (requestedAction?.action === "pause") {
      pauseRemaining = Math.max(0, Math.floor(requestedAction.pauseRounds ?? 0));
      step = strategyNextStep;
    } else if (requestedAction?.action === "reset") step = 0;
    else if (requestedAction?.action === "continue") step = (step + 1) % bets.length;
    else step = strategyNextStep;

    if (input.includeLedger && ledger.length < 10_000) {
      ledger.push({
        roundId: round.id,
        roundIndex,
        createdAt: new Date(round.createdAt).toISOString(),
        bust: round.bust,
        amount: bet.amount,
        cashout: bet.cashout,
        outcome,
        pnl,
        capital,
        strategyStep: placedStep,
        ruleId,
      });
    }
    equityCurve.push({ roundIndex, capital });

    if (scenario.stopLoss !== undefined && initialCapital - capital >= scenario.stopLoss) {
      stopReason = "Stop-loss reached";
    }
    if (scenario.takeProfit !== undefined && capital - initialCapital >= scenario.takeProfit) {
      stopReason = "Take-profit reached";
    }
    if (scenario.maxBets !== undefined && totalBets >= scenario.maxBets) {
      stopReason = "Maximum bet count reached";
    }
    if (stopReason) break;
  }

  if (input.includeLedger && totalBets > ledger.length) {
    warnings.push("Ledger was capped at 10,000 entries to limit response size");
  }
  const incompleteMetrics = rounds.filter((round) => round.metricsComplete === false).length;
  const detectedGaps = rounds.filter((round) => round.gapDetected).length;
  if (incompleteMetrics > 0) {
    warnings.push(`${incompleteMetrics.toLocaleString()} rounds have incomplete player or financial metrics; rules using those metrics do not match those rounds`);
  }
  if (detectedGaps > 0) {
    warnings.push(`${detectedGaps.toLocaleString()} rounds are marked with a data-continuity gap`);
  }

  const netProfit = Math.round((capital - initialCapital) * 100) / 100;
  return {
    summary: {
      startingCapital: initialCapital,
      endingCapital: capital,
      netProfit,
      roiPercent: (netProfit / initialCapital) * 100,
      totalBets,
      wins,
      losses,
      winRatePercent: totalBets > 0 ? (wins / totalBets) * 100 : 0,
      totalWagered: Math.round(totalWagered * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      grossLoss: Math.round(grossLoss * 100) / 100,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      maxDrawdownPercent,
      longestWinStreak,
      longestLossStreak,
      roundsProcessed,
      roundsSkipped,
      stoppedEarly: Boolean(stopReason),
      stopReason,
    },
    equityCurve: sampleEquityCurve(equityCurve),
    ...(input.includeLedger ? { ledger } : {}),
    warnings,
  };
}
