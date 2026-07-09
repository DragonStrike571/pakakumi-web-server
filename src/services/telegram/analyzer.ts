/**
 * Telegram Analyzer — Thin consumer of the independent Analysis Engine.
 *
 * This module:
 * 1. Calls the analysis engine to get results
 * 2. Formats and dispatches alerts to Telegram channels
 * 3. Uses simple, clear language for Kenyan users
 * 4. Includes ideal planning rounds in premium alerts
 * 5. Scales free channel timing hints without revealing exact data
 * 6. Includes today's accuracy in hit proof messages
 * 7. All messages flow through the global rate limiter
 */

import { bot } from "./bot.js";
import { InlineKeyboard } from "grammy";
import {
  runAnalysisEngine,
  FREE_CHANNEL_CONFIDENCE_THRESHOLD,
  TARGETS,
  type AnalysisResult,
} from "../analysis/engine.js";
import { rateLimitedSend } from "./rate-limiter.js";

// ─── Free Channel Timing Obfuscation ────────────────────────────────────────

/**
 * Convert an approximate round count into a vague, scaled phrase.
 * No exact numbers are revealed — words scale with the likely duration.
 */
function getVagueTimingPhrase(planRounds: number): string {
  if (planRounds <= 5) return "Any moment now";
  if (planRounds <= 15) return "Very soon";
  if (planRounds <= 30) return "Coming up shortly";
  if (planRounds <= 60) return "In the near future";
  if (planRounds <= 120) return "Building up — keep watching";
  return "Developing — patience needed";
}

/**
 * Main entry point — called on every new round from index.ts
 */
export async function runAnalysis(newRound?: {
  bust: number;
  createdAt: Date;
}): Promise<AnalysisResult | null> {
  const result = await runAnalysisEngine(newRound);

  const publicChannelId = process.env.PUBLIC_CHANNEL_ID;
  const privateChannelId = process.env.PRIVATE_CHANNEL_ID;
  const botUsername = bot?.botInfo?.username || "pk_oracle_bot";

  // ─── Dispatch hit proof messages ──────────────────────────────────────
  if (newRound && result.hitTargets.length > 0) {
    const hitTargetsStr = result.hitTargets
      .sort((a, b) => a - b)
      .map((t) => `${t.toFixed(2)}x`)
      .join(", ");

    const winRate =
      result.stats.totalSignals > 0
        ? ((result.stats.totalHits / result.stats.totalSignals) * 100).toFixed(1)
        : "0";

    // Today's accuracy line
    const todayLine = result.todayStats.totalPredictions > 0
      ? `\n📈 <b>Today:</b> ${result.todayStats.accuracy}% accurate (${result.todayStats.totalHits}/${result.todayStats.totalHits + result.todayStats.totalMisses} resolved)`
      : "";

    // Free Channel — proof message
    if (publicChannelId && bot) {
      const publicProofMsg =
        `🔥 <b>TARGET HIT!</b> 🔥\n\n` +
        `🎯 <b>Target:</b> &gt;${hitTargetsStr}\n` +
        `✅ <b>Game Result:</b> ${newRound.bust}x\n\n` +
        `📊 <b>Our Track Record:</b> ${winRate}% correct` +
        `${todayLine}\n\n` +
        `Premium members got this alert before it happened.`;

      const publicKb = new InlineKeyboard()
        .url(
          "Join Premium",
          `https://t.me/${botUsername}?start=premium`,
        )
        .row()
        .url("🤖 Plan My Bets", `https://t.me/${botUsername}`);

      await rateLimitedSend(publicChannelId, publicProofMsg, {
        parse_mode: "HTML",
        reply_markup: publicKb,
      }, "high").catch(console.error);
    }

    // Premium Channel — proof message
    if (privateChannelId && bot) {
      const premiumProofMsg =
        `✅ <b>TARGET CONFIRMED</b>\n\n` +
        `🎯 Targets: &gt;${hitTargetsStr}\n` +
        `💰 Game Result: <b>${newRound.bust}x</b>` +
        `${todayLine}\n\n` +
        `<i>Waiting for the next opportunity.</i>`;

      await rateLimitedSend(privateChannelId, premiumProofMsg, {
        parse_mode: "HTML",
      }, "high").catch(console.error);
    }
  }

  // ─── Dispatch new alert messages ──────────────────────────────────────
  if (result.clusters.length > 0 && bot) {
    let freeTargetDropped = false;

    for (const cluster of result.clusters) {
      // 1. PREMIUM CHANNEL — Full alert with reasoning + ideal plan
      if (privateChannelId) {
        // Pick the most relevant reason from the cluster
        const mainReason =
          cluster.alerts[0].reason || "The pattern shows this target is ready.";

        // Build the ideal plan line
        let idealLine = "";
        if (cluster.isLate) {
          idealLine =
            `\n⚠️ <b>Caution:</b> Timing is unpredictable right now. ` +
            `This target is overdue and the exact timing cannot be estimated. ` +
            `Proceed with smaller bets and extra patience.`;
        } else if (cluster.idealPlanRounds > 0) {
          idealLine =
            `\n📋 <b>Ideal Plan:</b> Budget for up to <b>${cluster.idealPlanRounds}</b> rounds` +
            `\n<i>(${cluster.roundsRange} expected + safety buffer for the target size)</i>`;
        }

        const premiumMsg =
          `⚠️ <b>NEW TARGET ALERT</b>\n\n` +
          `🎯 <b>Target:</b> &gt;${cluster.targetsStr}\n\n` +
          `📖 <b>Why:</b> ${mainReason}\n\n` +
          `⏱️ <b>Expected Window:</b> ${cluster.roundsRange} games\n` +
          `${idealLine}\n` +
          `📊 <b>How Sure:</b> ${cluster.avgConfidence}%\n` +
          `🔥 <b>Status:</b> ${cluster.status}\n\n` +
          `<i>Use the bot to plan your bets before you start.</i>`;

        const premiumKb = new InlineKeyboard()
          .url(
            "⚙️ Plan My Bets",
            `https://t.me/${botUsername}?start=strat_${cluster.alerts[0].target}`,
          )
          .row()
          .url("❓ How to Read This", `https://t.me/${botUsername}?start=guide`);

        await rateLimitedSend(privateChannelId, premiumMsg, {
          parse_mode: "HTML",
          reply_markup: premiumKb,
        }, "normal").catch(console.error);
      }

      // 2. FREE CHANNEL — Teaser with occasional free drop
      if (
        publicChannelId &&
        cluster.avgConfidence >= FREE_CHANNEL_CONFIDENCE_THRESHOLD
      ) {
        const isFreeDrop = !freeTargetDropped && Math.random() < 0.2;
        let teaseMsg = "";

        // Get vague timing phrase for free channel (no exact numbers)
        const vaguePhrase = getVagueTimingPhrase(cluster.planRounds);

        if (isFreeDrop) {
          freeTargetDropped = true;
          teaseMsg =
            `🎁 <b>FREE TARGET</b> 🎁\n\n` +
            `🎯 <b>Target:</b> &gt;${cluster.alerts[0].target}x\n\n` +
            `⏱️ <b>When:</b> ${vaguePhrase}\n\n` +
            `This is a free premium target. Plan your bets properly and don't force it.`;
        } else {
          teaseMsg =
            `🚨 <b>NEW ALERT</b> 🚨\n\n` +
            `📊 <b>How Sure:</b> ${cluster.avgConfidence}%\n` +
            `🎯 <b>Target:</b> [PREMIUM ONLY]\n\n` +
            `⏱️ <b>Timing:</b> ${vaguePhrase}\n\n` +
            `The exact target was just sent to Premium members.`;
        }

        const publicKb = new InlineKeyboard()
          .url("Join Premium", `https://t.me/${botUsername}?start=premium`)
          .row()
          .url("🤖 Plan My Bets", `https://t.me/${botUsername}`)
          .row()
          .url("❓ How It Works", `https://t.me/${botUsername}?start=guide`);

        await rateLimitedSend(publicChannelId, teaseMsg, {
          parse_mode: "HTML",
          reply_markup: publicKb,
        }, "low").catch(console.error);
      }
    }
  }

  // ─── Aggregate Correlation Alerts ──────────────────────────────────────
  if (bot && privateChannelId && result.activeSignals.length >= 3) {
    // 1. Get all active targets sorted
    const activeTargetValues = result.activeSignals.map((s) => s.target).sort((a, b) => a - b);

    // 2. Map them to their index in the TARGETS array
    const activeIndices = activeTargetValues
      .map((t) => TARGETS.indexOf(t))
      .filter((idx) => idx !== -1)
      .sort((a, b) => a - b);

    // 3. Find streaks of consecutive indices
    let currentStreak: number[] = [];
    const streaks: number[][] = [];

    for (let i = 0; i < activeIndices.length; i++) {
      if (currentStreak.length === 0) {
        currentStreak.push(activeIndices[i]);
      } else {
        if (activeIndices[i] === currentStreak[currentStreak.length - 1] + 1) {
          currentStreak.push(activeIndices[i]);
        } else {
          if (currentStreak.length >= 3) streaks.push([...currentStreak]);
          currentStreak = [activeIndices[i]];
        }
      }
    }
    if (currentStreak.length >= 3) streaks.push(currentStreak);

    // 4. Dispatch alert for each streak if it contains a NEWLY GENERATED alert
    const newTargetValues = new Set(result.alerts.map((a) => a.target));

    for (const streak of streaks) {
      const streakTargets = streak.map((idx) => TARGETS[idx]);
      const hasNewTarget = streakTargets.some((t) => newTargetValues.has(t));

      if (hasNewTarget) {
        const targetsStr = streakTargets.map((t) => `${t}x`).join(", ");
        const correlationMsg =
          `🔗 <b>AGGREGATE CORRELATION DETECTED</b>\n\n` +
          `A strong pattern has emerged. Multiple consecutive targets are active simultaneously:\n\n` +
          `🎯 <b>Correlated Targets:</b> &gt;${targetsStr}\n\n` +
          `💡 <b>What this means:</b> When ${streakTargets.length} or more sequential targets build up, it increases the probability of a breakout coming quite soon to clear them in one go. Proceed with a consolidated plan.`;

        await rateLimitedSend(privateChannelId, correlationMsg, {
          parse_mode: "HTML",
        }, "high").catch(console.error);
      }
    }
  }

  return result;
}
