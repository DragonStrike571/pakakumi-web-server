// services/telegram/risk.ts

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
        ? "🚨 DANGER: Your cash is too little for this target. You will lose everything fast."
        : "✅ SAFE: Follow these bets exactly and you have a good chance.",
  };
}

/**
 * Format the plan into simple, direct text for Telegram.
 * Written for standard Kenyan users — clear, no jargon.
 */
export function formatRiskMessage(bankroll: number, target: number): string {
  const plan = generateRiskPlan({ bankroll, target, strategy: "conservative" });

  let msg = `🛡️ <b>HOW TO PLAY SMART</b> 🛡️\n\n`;
  msg += `💰 <b>Your Cash:</b> KES ${bankroll.toLocaleString()}\n`;
  msg += `🎯 <b>Target:</b> ${target}x\n\n`;
  msg += `${plan.warning}\n\n`;

  msg += `🛑 <b>STOP LIMIT:</b> If you have lost KES ${plan.maxLossLimit.toLocaleString()}, STOP. Do not continue.\n\n`;

  if (plan.survivedRounds >= 1) {
    msg += `📝 <b>Your Betting Plan:</b>\n<i>(Stop immediately after you win)</i>\n\n`;
    plan.sequence.forEach((s) => {
      msg += `• Bet ${s.round}: Stake <b>KES ${s.bet.toLocaleString()}</b> <i>(Total spent: KES ${s.totalSpent.toLocaleString()})</i>\n`;
    });
  }

  msg += `\n⚠️ <i>Never put all your money on one round. If you miss all these bets, walk away. Come back another time.</i>`;

  return msg;
}
