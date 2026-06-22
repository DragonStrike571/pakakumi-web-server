import { db } from "../../db/index.js";
import { rounds } from "../../db/schema.js";
import { desc } from "drizzle-orm";
import { bot } from "./bot.js";

const HOUSE_EDGE = 0.01; // 1%
const TARGETS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90,
  100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1500,
  2000, 2500, 3000,
];

// In-Memory Cache for fast sequential reads
let cachedRounds: { bust: number; createdAt: Date }[] = [];

// THE SIGNAL QUEUE: Tracks active signals waiting for a mathematical win
interface ActiveSignal {
  target: number;
  confidence: number;
  roundsElapsed: number;
  maxLifespan: number; // Dynamically calculated limit before the queue drops it
}
let pendingProofs: ActiveSignal[] = [];

export async function runAnalysis(newRound?: {
  bust: number;
  createdAt: Date;
}) {
  // 1. POPULATE OR UPDATE CACHE
  if (cachedRounds.length === 0) {
    cachedRounds = await db.query.rounds.findMany({
      orderBy: [desc(rounds.createdAt)],
      limit: 10000,
      columns: { bust: true, createdAt: true },
    });
  } else if (newRound) {
    cachedRounds.unshift(newRound);
    if (cachedRounds.length > 10000) cachedRounds.pop();
  }

  const recentRounds = cachedRounds;
  if (recentRounds.length === 0) return;

  const publicChannelId = process.env.PUBLIC_CHANNEL_ID;
  const privateChannelId = process.env.PRIVATE_CHANNEL_ID;

  // =========================================================================
  // STEP 1: EVALUATE PENDING SIGNALS FOR PUBLIC MARKETING (THE FOMO MACHINE)
  // =========================================================================
  if (newRound && pendingProofs.length > 0) {
    const hitSignals = pendingProofs.filter((s) => newRound.bust >= s.target);

    if (hitSignals.length > 0) {
      const bestHit = hitSignals.reduce((prev, current) =>
        prev.target > current.target ? prev : current,
      );

      // 1. Send FOMO Proof to Public Channel
      if (publicChannelId) {
        const publicProofMsg =
          `🔥 <b>SYSTEM WIN VERIFIED ON-CHAIN</b> 🔥\n\n` +
          `🎯 <b>Target Hunted:</b> &gt;${bestHit.target.toFixed(2)}x\n` +
          `✅ <b>Actual House Crash:</b> ${newRound.bust}x\n\n` +
          `Premium members were notified before this flight took off.\n\n` +
          `👇 <b>Upgrade via Bot to get live entries</b>`;

        bot?.api
          .sendMessage(publicChannelId, publicProofMsg, { parse_mode: "HTML" })
          .catch(console.error);
      }

      // 2. NEW: Send Execution Proof to Premium Channel
      if (privateChannelId) {
        const premiumProofMsg =
          `✅ **TARGET RESOLVED**\n\n` +
          `The algorithm successfully mapped the >${bestHit.target.toFixed(2)}x exit.\n` +
          `Actual Crash: **${newRound.bust}x**\n\n` +
          `_System matrix updated. Awaiting next variance pocket._`;

        bot?.api
          .sendMessage(privateChannelId, premiumProofMsg, {
            parse_mode: "Markdown",
          })
          .catch(console.error);
      }
    }

    // Queue Cleanup
    pendingProofs = pendingProofs
      .filter((s) => newRound.bust < s.target)
      .map((s) => ({ ...s, roundsElapsed: s.roundsElapsed + 1 }))
      .filter((s) => s.roundsElapsed < s.maxLifespan);
  }

  // =========================================================================
  // STEP 2: GENERATE NEW ALGORITHMIC SIGNALS
  // =========================================================================
  const analysisResults = [];
  const alertsToDispatch = [];

  for (const target of TARGETS) {
    const expectedGap = target / (1 - HOUSE_EDGE);

    // Find up to 6 occurrences to get 5 previous gaps
    const K = 5;
    const occIndices: number[] = [];
    for (let i = 0; i < recentRounds.length; i++) {
      if (recentRounds[i].bust >= target) {
        occIndices.push(i);
        if (occIndices.length >= K + 1) break;
      }
    }

    if (occIndices.length === 0) continue;

    const currentGap = occIndices[0];
    const gapsUsed = occIndices.length - 1;

    let expectedNextGap = expectedGap;

    if (gapsUsed > 0) {
      const sumOfPreviousGaps = occIndices[gapsUsed] - occIndices[0];
      const expectedTotalForNextGaps = (gapsUsed + 1) * expectedGap;

      expectedNextGap = expectedTotalForNextGaps - sumOfPreviousGaps;
      if (expectedNextGap < 1) expectedNextGap = 1; // Clamp to avoid negatives
    }

    const overdueRatio = currentGap / expectedNextGap;

    let overdueChance = 0;
    if (overdueRatio >= 1.0) overdueChance = 50;
    if (overdueRatio >= 1.2) overdueChance = 60;
    if (overdueRatio >= 1.5) overdueChance = 75;
    if (overdueRatio >= 1.8) overdueChance = 95;
    if (overdueRatio >= 2.0) overdueChance = 99; // Imminent

    analysisResults.push({
      target,
      expectedGap,
      currentGap,
      expectedNextGap,
      overdueChance,
    });

    // Only dispatch highly actionable setups
    if (overdueChance >= 75) {
      alertsToDispatch.push({
        target,
        overdueChance,
        expectedNextGap,
        currentGap,
      });
    }
  }

  // =========================================================================
  // STEP 3: DISPATCH ALERTS (PREMIUM VS PUBLIC)
  // =========================================================================
  if (alertsToDispatch.length > 0 && bot) {
    // 1. Send actionable entries to PREMIUM channel
    if (privateChannelId) {
      const premiumText = alertsToDispatch
        .map(
          (alert) =>
            `⚠️ <b>LIVE ENTRY DETECTED</b>\n\n` +
            `<b>Target:</b> &gt;${alert.target}x\n` +
            `<b>Confidence:</b> ${alert.overdueChance}%\n` +
            `<b>Current Gap:</b> ${alert.currentGap} rounds\n` +
            `<b>Signal Strength:</b> ${alert.overdueChance >= 95 ? "🔴 EXTREME" : "🟡 HIGH"}`,
        )
        .join("\n\n---\n\n");

      bot.api
        .sendMessage(privateChannelId, premiumText, { parse_mode: "HTML" })
        .catch(console.error);
    }

    // 2. Identify extreme signals for the PUBLIC FOMO queue
    const extremeAlerts = alertsToDispatch.filter((a) => a.overdueChance >= 95);

    if (publicChannelId && extremeAlerts.length > 0) {
      // Send ONE blind teaser to the public channel (hiding the targets)
      const teaseMsg =
        `🚨 <b>ALGORITHM DETECTED ANOMALY</b> 🚨\n\n` +
        `<b>Confidence:</b> 99%\n<b>Target Multiplier:</b> [HIDDEN]\n\n` +
        `A high-multiplier variance pocket is opening in the next few rounds. Exact exit targets were just dispatched to the Premium Room.`;

      bot.api
        .sendMessage(publicChannelId, teaseMsg, { parse_mode: "HTML" })
        .catch(console.error);

      // Push the targets into the queue to await public proof.
      // Dynamic Lifespan: Give high targets more time to hit before dropping them.
      // Minimum wait is 10 rounds, scales up heavily for huge targets.
      extremeAlerts.forEach((alert) => {
        // Prevent duplicate queue entries for the same target
        if (!pendingProofs.find((p) => p.target === alert.target)) {
          const dynamicLifespan = Math.max(10, Math.ceil(alert.target * 2));

          pendingProofs.push({
            target: alert.target,
            confidence: alert.overdueChance,
            roundsElapsed: 0,
            maxLifespan: dynamicLifespan,
          });
        }
      });
    }
  }

  return analysisResults;
}
