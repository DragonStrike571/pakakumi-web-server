import { db } from "../../db/index.js";
import { rounds } from "../../db/schema.js";
import { desc } from "drizzle-orm";
import { bot } from "./bot.js";
import { InlineKeyboard } from "grammy";

const HOUSE_EDGE = 0.01; // 1%
const TARGETS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90,
  100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1500,
  2000, 2500, 3000,
];

let cachedRounds: { bust: number; createdAt: Date }[] = [];

interface ActiveSignal {
  target: number;
  confidence: number;
  roundsElapsed: number;
  maxLifespan: number; // Now completely adaptive
}
let pendingProofs: ActiveSignal[] = [];

const cooldownMap = new Map<number, number>();
let systemStats = { hits: 0, signals: 0 };
let currentRoundIndex = 0;

export async function runAnalysis(newRound?: {
  bust: number;
  createdAt: Date;
}) {
  if (cachedRounds.length === 0) {
    cachedRounds = await db.query.rounds.findMany({
      orderBy: [desc(rounds.createdAt)],
      limit: 10000,
      columns: { bust: true, createdAt: true },
    });
  } else if (newRound) {
    cachedRounds.unshift(newRound);
    if (cachedRounds.length > 10000) cachedRounds.pop();
    currentRoundIndex++;
  }

  const recentRounds = cachedRounds;
  if (recentRounds.length === 0) return;

  const publicChannelId = process.env.PUBLIC_CHANNEL_ID;
  const privateChannelId = process.env.PRIVATE_CHANNEL_ID;
  const botUsername = bot?.botInfo?.username || "PakakumiOracleBot";

  // =========================================================================
  // STEP 1: EVALUATE PENDING SIGNALS & UPDATE STATS
  // =========================================================================
  if (newRound && pendingProofs.length > 0) {
    const hitSignals = pendingProofs.filter((s) => newRound.bust >= s.target);

    if (hitSignals.length > 0) {
      systemStats.hits += hitSignals.length;

      const bestHit = hitSignals.reduce((prev, current) =>
        prev.target > current.target ? prev : current,
      );

      const winRate = (
        (systemStats.hits / Math.max(1, systemStats.signals)) *
        100
      ).toFixed(1);

      // 1. Send Proof to Free Channel
      if (publicChannelId) {
        const publicProofMsg =
          `🔥 <b>TARGET HIT</b> 🔥\n\n` +
          `🎯 <b>Target:</b> &gt;${bestHit.target.toFixed(2)}x\n` +
          `✅ <b>Actual Crash:</b> ${newRound.bust}x\n\n` +
          `📊 <b>Accuracy:</b> ${winRate}%\n\n` +
          `Premium members got this alert early.`;

        const publicKb = new InlineKeyboard()
          .url(
            "Get Premium Alerts",
            `https://t.me/${botUsername}?start=premium`,
          )
          .row()
          .url("🤖 Use Bot to Plan Bets", `https://t.me/${botUsername}`); // <-- FIXED THIS

        bot?.api
          .sendMessage(publicChannelId, publicProofMsg, {
            parse_mode: "HTML",
            reply_markup: publicKb,
          })
          .catch(console.error);
      }

      // 2. Send Proof to Premium Channel
      if (privateChannelId) {
        const premiumProofMsg =
          `✅ **TARGET SECURED**\n\n` +
          `Target: >${bestHit.target.toFixed(2)}x\n` +
          `Actual Crash: **${newRound.bust}x**\n\n` +
          `_Waiting for the next hot target._`;

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
      .filter((s) => {
        const alive = s.roundsElapsed < s.maxLifespan;
        if (!alive) cooldownMap.delete(s.target);
        return alive;
      });
  }

  // =========================================================================
  // STEP 2: GENERATE SIGNALS
  // =========================================================================
  const rawAlerts = [];

  for (const target of TARGETS) {
    const expectedGap = target / (1 - HOUSE_EDGE);
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
      if (expectedNextGap < 1) expectedNextGap = 1;
    }

    const overdueRatio = currentGap / expectedNextGap;

    const baseConfidence = overdueRatio * 50;
    const riskPenalty = Math.log10(target) * 8;
    let confidence = Math.min(99, Math.round(baseConfidence - riskPenalty));

    const expectedRoundsRemaining = Math.max(
      0,
      Math.round(expectedNextGap - currentGap),
    );

    if (confidence >= 75 && !cooldownMap.has(target)) {
      rawAlerts.push({
        target,
        confidence,
        expectedRoundsRemaining,
        overdueRatio,
      });
    }
  }

  if (rawAlerts.length === 0) return [];

  // =========================================================================
  // STEP 2.5: ANCHOR-BASED CLUSTERING
  // =========================================================================
  const clusters = [];
  rawAlerts.sort((a, b) => a.target - b.target);

  if (rawAlerts.length > 0) {
    let currentCluster = [rawAlerts[0]];
    let clusterAnchor = rawAlerts[0].target; // Strict boundary anchor

    for (let i = 1; i < rawAlerts.length; i++) {
      const current = rawAlerts[i];

      // Group ONLY if target is within 50% of the CLUSTER'S ANCHOR
      // This immediately kills the infinite chaining effect
      if (current.target <= clusterAnchor * 1.5) {
        currentCluster.push(current);
      } else {
        clusters.push([...currentCluster]);
        currentCluster = [current];
        clusterAnchor = current.target; // Set new anchor
      }
    }
    if (currentCluster.length > 0) clusters.push(currentCluster);
  }

  // =========================================================================
  // STEP 3: DISPATCH ALERTS
  // =========================================================================

  if (clusters.length > 0 && bot) {
    let freeTargetDropped = false;

    for (const cluster of clusters) {
      cluster.forEach((c) => cooldownMap.set(c.target, currentRoundIndex));
      systemStats.signals++;

      const targetsStr = cluster.map((c) => `${c.target}x`).join(", ");
      const avgConfidence = Math.round(
        cluster.reduce((sum, c) => sum + c.confidence, 0) / cluster.length,
      );

      // Extract the algorithm's actual expected gap math
      const minExpected = Math.min(
        ...cluster.map((c) => c.expectedRoundsRemaining),
      );
      const maxExpected = Math.max(
        ...cluster.map((c) => c.expectedRoundsRemaining),
      );

      // Add a dynamic safety buffer based on the lowest target in the cluster
      // Lower targets get smaller buffers, massive targets get larger survival buffers
      const safetyBuffer = Math.max(5, Math.ceil(cluster[0].target));
      const lowerLimit = Math.max(1, minExpected);

      // Force upperLimit to always be at least equal to lowerLimit
      const upperLimit = Math.max(lowerLimit, maxExpected + safetyBuffer);

      const planRounds = upperLimit;

      const roundsRange =
        lowerLimit === upperLimit
          ? `Within ${upperLimit}`
          : `${lowerLimit} to ${upperLimit}`;

      const status =
        cluster[0].overdueRatio >= 2.0 ? "Very Overdue" : "Hot & Ready";

      // 1. PREMIUM DISPATCH
      if (privateChannelId) {
        const premiumMsg =
          `⚠️ <b>HOT TARGETS FOUND</b>\n\n` +
          `<b>Targets:</b> &gt;${targetsStr}\n\n` +
          `<b>Action Window:</b> ${roundsRange} rounds\n` +
          `<b>Confidence:</b> ${avgConfidence}%\n` +
          `<b>Status:</b> ${status}\n\n` +
          `_Use the bot to plan your bets before you start._`;

        const premiumKb = new InlineKeyboard().url(
          "⚙️ Plan My Bets",
          `https://t.me/${botUsername}?start=strat_${cluster[0].target}`,
        );

        bot.api
          .sendMessage(privateChannelId, premiumMsg, {
            parse_mode: "HTML",
            reply_markup: premiumKb,
          })
          .catch(console.error);
      }

      // 2. FREE DISPATCH
      if (publicChannelId && avgConfidence >= 90) {
        const isFreeDrop = !freeTargetDropped && Math.random() < 0.2;

        let teaseMsg = "";
        if (isFreeDrop) {
          freeTargetDropped = true;
          teaseMsg =
            `🎁 <b>FREE TARGET DROP</b> 🎁\n\n` +
            `<b>Target:</b> &gt;${cluster[0].target}x\n\n` +
            `<b>Action Window:</b> ${roundsRange} rounds\n\n` +
            `Here is a free premium target. Bet wisely and don't force it.`;
        } else {
          teaseMsg =
            `🚨 <b>NEW TARGET ALERT</b> 🚨\n\n` +
            `<b>Confidence:</b> ${avgConfidence}%\n` +
            `<b>Target:</b> [HIDDEN]\n\n` +
            `<b>Action Window:</b> ${roundsRange} rounds\n\n` +
            `The exact multipliers were just sent to Pakakumi Oracle Premium.`;
        }

        const publicKb = new InlineKeyboard()
          .url("Get Premium", `https://t.me/${botUsername}?start=premium`)
          .row()
          .url("🤖 Use Bot to Plan Bets", `https://t.me/${botUsername}`); // <-- ADDED THIS FOR CONSISTENCY

        bot.api
          .sendMessage(publicChannelId, teaseMsg, {
            parse_mode: "HTML",
            reply_markup: publicKb,
          })
          .catch(console.error);

        cluster.forEach((c) => {
          if (!pendingProofs.find((p) => p.target === c.target)) {
            const adaptiveLifespan = planRounds + Math.ceil(c.target * 0.85);
            pendingProofs.push({
              target: c.target,
              confidence: c.confidence,
              roundsElapsed: 0,
              maxLifespan: adaptiveLifespan,
            });
          }
        });
      }
    }
  }

  return rawAlerts;
}
