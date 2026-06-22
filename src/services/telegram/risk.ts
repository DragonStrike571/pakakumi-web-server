// services/bot/risk.ts

interface RiskProfile {
  bankroll: number;
  target: number;
  strategy: "conservative" | "aggressive";
}

export function generateRiskPlan({ bankroll, target, strategy }: RiskProfile) {
  // Internal math remains the same, but we simplify the public-facing variables
  const riskPercentage = strategy === "conservative" ? 0.01 : 0.05;
  const maxLossLimit = bankroll * 0.2; // 20% max loss before telling them to stop

  const baseBet = Math.max(10, Math.floor(bankroll * riskPercentage));

  const sequence: {
    round: number;
    bet: number;
    totalSpent: number;
    profitIfHit: number;
  }[] = [];

  let currentRisk = 0;
  let currentBet = baseBet;

  for (let round = 1; round <= 10; round++) {
    if (currentRisk + currentBet > maxLossLimit) break;

    const profitIfHit = currentBet * target - (currentRisk + currentBet);

    sequence.push({
      round,
      bet: Math.round(currentBet),
      totalSpent: Math.round(currentRisk + currentBet),
      profitIfHit: Math.round(profitIfHit),
    });

    currentRisk += currentBet;
    currentBet = (currentRisk + baseBet) / (target - 1);
  }

  const survivedRounds = sequence.length;

  return {
    baseBet,
    survivedRounds,
    maxLossLimit: Math.round(maxLossLimit),
    sequence,
    warning:
      survivedRounds < 3
        ? "🚨 DANGER: Your balance is too small for this target. You will lose everything fast."
        : "✅ SAFE: Follow these exact bets so you don't go broke.",
  };
}

/**
 * Utility to format the plan into simple, direct Telegram text
 */
export function formatRiskMessage(bankroll: number, target: number): string {
  const plan = generateRiskPlan({ bankroll, target, strategy: "conservative" });

  let msg = `🛡️ **HOW TO SURVIVE** 🛡️\n\n`;
  msg += `💰 **Your Cash:** KES ${bankroll}\n`;
  msg += `🎯 **Target:** ${target}x\n\n`;
  msg += `${plan.warning}\n\n`;

  msg += `🛑 **HARD STOP:** If you lose KES ${plan.maxLossLimit}, STOP PLAYING.\n\n`;

  if (plan.survivedRounds >= 1) {
    msg += `📝 **Your Betting Plan (Stop immediately after you win):**\n`;
    plan.sequence.forEach((s) => {
      msg += `• Bet ${s.round}: Stake **KES ${s.bet}** _(Total spent: KES ${s.totalSpent})_\n`;
    });
  }

  msg += `\n⚠️ _Never put all your money at once. If you miss all these bets, walk away. The game doesn't care about your feelings._`;

  return msg;
}
