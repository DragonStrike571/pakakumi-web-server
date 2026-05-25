export type StrategyType = "sequence" | "algorithm";

export interface StrategyConfig {
  type: StrategyType;
  stopAfterWin?: boolean;
  autoCashout?: number;

  algorithm?: {
    capital: number;
    minAmount: number;
    multiplier: number;
    targetReturn: number;
    roundingOption?: "none" | "whole" | "five" | "ten";
    maxPlayable?: number;
  };

  sequence?: {
    bets: Array<{
      amount: number;
      cashout: number;
    }>;
  };
}

export interface BetAction {
  shouldBet: boolean;
  amount: number;
  cashout: number;
  stop?: boolean;
}

export function roundNumber(
  num: number,
  option?: "none" | "whole" | "five" | "ten",
): number {
  let rounded: number;
  switch (option) {
    case "whole":
      rounded = Math.round(num);
      break;
    case "five":
      rounded = Math.ceil(num / 5) * 5;
      break;
    case "ten":
      rounded = Math.ceil(num / 10) * 10;
      break;
    default:
      rounded = Math.round(num * 100) / 100;
      break;
  }
  return rounded;
}

/**
 * Generate a sequence of algorithm-based bets.
 */
export function generateAlgorithmBets(
  capital: number,
  minAmount: number,
  multiplier: number,
  targetReturn: number,
  roundingOption?: "none" | "whole" | "five" | "ten",
  maxPlayable?: number,
): Array<{ amount: number; cashout: number }> {
  let currentAmount = minAmount;
  let totalSum = 0;
  const numbersAdded: number[] = [];

  const MAX_ROUNDS = 10000;
  let loops = 0;

  const shouldRound = roundingOption && roundingOption !== "none";

  while (true) {
    if (loops++ > MAX_ROUNDS) break;

    let bet = currentAmount;
    if (shouldRound) {
      bet = roundNumber(bet, roundingOption);
    } else {
      bet = Math.round(bet * 100) / 100;
    }

    if (maxPlayable && bet > maxPlayable) break;
    if (totalSum + bet > capital) break;

    totalSum += bet;
    numbersAdded.push(bet);

    // Direct math calculation instead of O(N) loop
    const nextRequired = (targetReturn * totalSum) / multiplier;
    
    if (nextRequired > currentAmount) {
      currentAmount = nextRequired;
    }
    
    // Round up to nearest cent to ensure target is met
    currentAmount = Math.ceil(currentAmount * 100) / 100;
    
    // Safety checks for unexpected mathematical instances
    if (!isFinite(currentAmount) || isNaN(currentAmount)) {
      break;
    }
  }

  return numbersAdded.map((amount) => ({
    amount,
    cashout: multiplier,
  }));
}

/**
 * Determine the next bet action based on the strategy and current step.
 *
 * @param config      - The strategy configuration
 * @param currentStep - Index of the bet to place next (0-based)
 * @param lastRoundResult - Result of the previous round (if a bet was placed)
 *
 * @returns The action to take and the next step index
 */
export function executeStrategy(
  config: StrategyConfig,
  currentStep: number,
  lastRoundResult?: { bust: number; betPlaced: number; cashout: number },
): { action: BetAction; nextStep: number } {
  const bets =
    config.type === "algorithm" && config.algorithm
      ? generateAlgorithmBets(
          config.algorithm.capital,
          config.algorithm.minAmount,
          config.algorithm.multiplier,
          config.algorithm.targetReturn,
          config.algorithm.roundingOption,
          config.algorithm.maxPlayable,
        )
      : config.sequence?.bets || [];

  // Empty strategy — nothing to do
  if (bets.length === 0) {
    return {
      action: { shouldBet: false, amount: 0, cashout: 0, stop: true },
      nextStep: 0,
    };
  }

  // Process previous round result
  if (lastRoundResult) {
    const { bust, cashout } = lastRoundResult;
    const won = bust >= cashout;

    if (won && config.stopAfterWin) {
      return {
        action: { shouldBet: false, amount: 0, cashout: 0, stop: true },
        nextStep: currentStep,
      };
    }

    // Reset to beginning on win
    if (won) {
      const firstBet = bets[0];
      const finalCashout = config.autoCashout || firstBet.cashout;
      return {
        action: {
          shouldBet: true,
          amount: firstBet.amount,
          cashout: finalCashout,
          stop: false,
        },
        nextStep: 1,
      };
    }

    // On loss, continue to currentStep (caller already advanced the index)
  }

  // Wrap around if strategy exhausted (restart from beginning)
  if (currentStep >= bets.length) {
    const firstBet = bets[0];
    const finalCashout = config.autoCashout || firstBet.cashout;
    return {
      action: {
        shouldBet: true,
        amount: firstBet.amount,
        cashout: finalCashout,
        stop: false,
      },
      nextStep: 1,
    };
  }

  const bet = bets[currentStep];
  const finalCashout = config.autoCashout || bet.cashout;

  return {
    action: {
      shouldBet: true,
      amount: bet.amount,
      cashout: finalCashout,
      stop: false,
    },
    nextStep: currentStep + 1,
  };
}
