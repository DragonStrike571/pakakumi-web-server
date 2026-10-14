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
import { getBotUsername } from "./bot-identity.js";
import { InlineKeyboard } from "grammy";
import {
  runAnalysisEngine,
  FREE_CHANNEL_CONFIDENCE_THRESHOLD,
  TARGETS,
  type AnalysisResult,
} from "../analysis/engine.js";
import { rateLimitedSend } from "./rate-limiter.js";
import { runBackgroundTask } from "../../utils/background-task.js";
import {
  processAutoPlayOpportunities,
  clearResolvedCluster,
} from "../auto-play.js";

// ─── Free Channel Timing Obfuscation ────────────────────────────────────────

/**
 * Convert an approximate round count into a vague, scaled phrase.
 * No exact numbers are revealed — words scale with the likely duration.
 */
function getVagueTimingPhrase(planRounds: number): string {
  if (planRounds <= 15) return "Short model planning window";
  if (planRounds <= 60) return "Medium model planning window";
  return "Long model planning window";
}

/**
 * Main entry point — called on every new round from index.ts
 */
export async function runAnalysis(newRound?: {
  id?: string;
  bust: number;
  createdAt: Date;
}): Promise<AnalysisResult | null> {
  const result = await runAnalysisEngine(newRound);
  if (result.replayed) return result;

  // Auto-play decisions and WebSocket updates must not wait for Telegram delivery.
  if (result.correlationClusters.length > 0) await processAutoPlayOpportunities(result);
  if (result.hitTargets.length > 0) clearResolvedCluster(result.hitTargets);
  runBackgroundTask("Telegram analysis delivery", () => deliverAnalysis(result, newRound));
  return result;
}

async function deliverAnalysis(result: AnalysisResult, newRound?: { bust: number; createdAt: Date }) {

  const publicChannelId = process.env.PUBLIC_CHANNEL_ID;
  const privateChannelId = process.env.PRIVATE_CHANNEL_ID;
  const botUsername = getBotUsername(bot);

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
          cluster.alerts[0].reason || "A historical gap threshold was reached.";

        // Build the ideal plan line
        let idealLine = "";
        if (cluster.isLate) {
          idealLine =
            `\n⚠️ <b>Caution:</b> Timing is unpredictable right now. ` +
            `A longer gap does not make the next round more likely to hit. ` +
            `The model cannot determine the next hit.`;
        } else if (cluster.idealPlanRounds > 0) {
          idealLine =
            `\n📋 <b>Ideal Plan:</b> Budget for up to <b>${cluster.idealPlanRounds}</b> rounds` +
            `\n<i>(${cluster.roundsRange} expected + safety buffer for the target size)</i>`;
        }

        const premiumMsg =
          `⚠️ <b>NEW TARGET ALERT</b>\n\n` +
          `🎯 <b>Target:</b> &gt;${cluster.targetsStr}\n\n` +
          `📖 <b>Why:</b> ${mainReason}\n\n` +
          `⏱️ <b>Model Window:</b> ${cluster.roundsRange} games\n` +
          `${idealLine}\n` +
          `📊 <b>Heuristic Score:</b> ${cluster.avgConfidence}%\n` +
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
            `⏱️ <b>Model Window:</b> ${vaguePhrase}\n\n` +
            `This is a free premium target. Plan your bets properly and don't force it.`;
        } else {
          teaseMsg =
            `🚨 <b>NEW ALERT</b> 🚨\n\n` +
            `📊 <b>Heuristic Score:</b> ${cluster.avgConfidence}%\n` +
            `🎯 <b>Target:</b> [PREMIUM ONLY]\n\n` +
            `⏱️ <b>Model Window:</b> ${vaguePhrase}\n\n` +
            `The target was just sent to Premium members. The score is not a win probability.`;
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
  if (bot && privateChannelId && result.correlationStreaks.length > 0) {
    const newTargetValues = new Set(result.alerts.map((a) => a.target));

    for (const streakTargets of result.correlationStreaks) {
      const hasNewTarget = streakTargets.some((t) => newTargetValues.has(t));

      if (hasNewTarget) {
        const targetsStr = streakTargets.map((t) => `${t}x`).join(", ");
        const correlationMsg =
          `🔗 <b>AGGREGATE CORRELATION DETECTED</b>\n\n` +
          `Several historical gap thresholds were reached at the same time. This does not predict a big round.\n\n` +
          `🎯 <b>Correlated Targets:</b> &gt;${targetsStr}\n\n` +
          `💡 <b>What this means:</b> ${streakTargets.length} targets passed model thresholds. Each round remains independent; the next result is unknown.`;

        await rateLimitedSend(privateChannelId, correlationMsg, {
          parse_mode: "HTML",
        }, "high").catch(console.error);
      }
    }
  }

  // ─── Process Auto-Play Opportunities ───────────────────────────────────
  // Write opportunities to DB for the local bot to pick up
  // Auto-play was processed before scheduling delivery.

  // Clear resolved clusters when targets are hit

  return result;
}
