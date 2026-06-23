import { db } from "../../db/index.js";
import { rounds, systemStats, pendingSignals } from "../../db/schema.js";
import { desc, asc, eq, inArray, sql } from "drizzle-orm";
import { bot } from "./bot.js";
import { InlineKeyboard } from "grammy";
import { SQL, Placeholder } from "drizzle-orm/sql";

const HOUSE_EDGE = 0.01; // 1%
const TARGETS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90,
  100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1500,
  2000, 2500, 3000,
];

// O(1) Push Array Buffer
let cachedRounds: { bust: number; createdAt: Date }[] = [];
const cooldownMap = new Map<number, number>();
let currentRoundIndex = 0;

export async function runAnalysis(newRound?: {
  bust: number;
  createdAt: Date;
}) {
  // Load State from Database (Persistence Fix)
  let stats = await db
    .select()
    .from(systemStats)
    .where(eq(systemStats.id, 1))
    .then((res) => res[0]);

  if (!stats) {
    stats = { id: 1, hits: 0, signals: 0 };
    await db.insert(systemStats).values(stats);
  }

  let pendingProofs = await db.select().from(pendingSignals);

  // Array Bottleneck Fix (O(1) Push & Batch Slice)
  if (cachedRounds.length === 0) {
    // Fetch ASCENDING so oldest is [0], newest is end
    cachedRounds = await db.query.rounds.findMany({
      orderBy: [asc(rounds.createdAt)],
      limit: 10000,
      columns: { bust: true, createdAt: true },
    });
  } else if (newRound) {
    cachedRounds.push(newRound); // O(1)
    if (cachedRounds.length > 11000) {
      cachedRounds = cachedRounds.slice(cachedRounds.length - 10000);
    }
    currentRoundIndex++;
  }

  const recentRounds = cachedRounds;
  if (recentRounds.length === 0) return;

  const publicChannelId = process.env.PUBLIC_CHANNEL_ID;
  const privateChannelId = process.env.PRIVATE_CHANNEL_ID;
  const botUsername = bot?.botInfo?.username || "pk_oracle_bot";

  // =========================================================================
  // STEP 1: EVALUATE PENDING SIGNALS & UPDATE STATS
  // =========================================================================
  if (newRound && pendingProofs.length > 0) {
    const hitSignals = pendingProofs.filter((s) => newRound.bust >= s.target);

    if (hitSignals.length > 0) {
      // 1. Update DB Stats
      stats.hits += hitSignals.length;
      await db
        .update(systemStats)
        .set({ hits: stats.hits })
        .where(eq(systemStats.id, 1));

      // 2. Clear Hits from Cooldown and DB
      const hitTargets = hitSignals.map((s) => s.target);
      hitTargets.forEach((t) => cooldownMap.delete(t));
      await db
        .delete(pendingSignals)
        .where(inArray(pendingSignals.target, hitTargets));

      // 3. String Fix: Map all hits instead of reducing
      hitSignals.sort((a, b) => a.target - b.target);
      const hitTargetsStr = hitSignals
        .map((s) => `${s.target.toFixed(2)}x`)
        .join(", ");

      const winRate = ((stats.hits / Math.max(1, stats.signals)) * 100).toFixed(
        1,
      );

      // Free Channel
      if (publicChannelId) {
        const publicProofMsg =
          `🔥 <b>TARGETS CLEARED</b> 🔥\n\n` +
          `🎯 <b>Targets:</b> &gt;${hitTargetsStr}\n` +
          `✅ <b>Actual Crash:</b> ${newRound.bust}x\n\n` +
          `📊 <b>Accuracy:</b> ${winRate}%\n\n` +
          `Premium members got this alert early.`;

        const publicKb = new InlineKeyboard()
          .url(
            "Get Premium Alerts",
            `https://t.me/${botUsername}?start=premium`,
          )
          .row()
          .url("🤖 Use Bot to Plan Bets", `https://t.me/${botUsername}`);

        await bot?.api
          .sendMessage(publicChannelId, publicProofMsg, {
            parse_mode: "HTML",
            reply_markup: publicKb,
          })
          .catch(console.error);
      }

      // Premium Channel
      if (privateChannelId) {
        const premiumProofMsg =
          `✅ **TARGETS SECURED**\n\n` +
          `Targets: >${hitTargetsStr}\n` +
          `Actual Crash: **${newRound.bust}x**\n\n` +
          `_Waiting for the next hot target._`;

        await bot?.api
          .sendMessage(privateChannelId, premiumProofMsg, {
            parse_mode: "Markdown",
          })
          .catch(console.error);
      }
    }

    // Queue Cleanup for Dead/Expired Signals
    const deadSignals = pendingProofs.filter(
      (s) => newRound.bust < s.target && s.roundsElapsed + 1 >= s.maxLifespan,
    );
    if (deadSignals.length > 0) {
      const deadTargets = deadSignals.map((s) => s.target);
      deadTargets.forEach((t) => cooldownMap.delete(t));
      await db
        .delete(pendingSignals)
        .where(inArray(pendingSignals.target, deadTargets));
    }

    // Update elapsed rounds for survivors
    if (pendingProofs.length > 0 && deadSignals.length < pendingProofs.length) {
      await db.execute(
        sql`UPDATE pending_signals SET rounds_elapsed = rounds_elapsed + 1`,
      );
    }
  }

  // =========================================================================
  // STEP 2: MATHEMATICAL SIGNAL GENERATION
  // =========================================================================
  const rawAlerts = [];

  for (const target of TARGETS) {
    const expectedGap = target / (1 - HOUSE_EDGE);
    const K = 5;
    const occIndices: number[] = [];

    // Array Bottleneck Fix: Traverse BACKWARDS since end of array is the newest
    for (let i = recentRounds.length - 1; i >= 0; i--) {
      if (recentRounds[i].bust >= target) {
        const distance = recentRounds.length - 1 - i;
        occIndices.push(distance);
        if (occIndices.length >= K + 1) break;
      }
    }

    if (occIndices.length === 0) continue;

    const currentGap = occIndices[0];
    if (currentGap === 0) continue;

    const gapsUsed = occIndices.length - 1;
    let expectedNextGap = expectedGap;

    if (gapsUsed > 0) {
      const sumOfPreviousGaps = occIndices[gapsUsed] - occIndices[0];
      const expectedTotalForNextGaps = (gapsUsed + 1) * expectedGap;
      expectedNextGap = expectedTotalForNextGaps - sumOfPreviousGaps;
    }

    const expectedRoundsRemaining = Math.max(
      0,
      Math.round(expectedNextGap - currentGap),
    );
    const pureOverdueRatio = currentGap / expectedGap;

    let confidence = 0;
    if (expectedNextGap <= 0) {
      confidence = 99;
    } else {
      const baseConfidence = (currentGap / expectedNextGap) * 100;
      confidence = Math.min(99, Math.round(baseConfidence));
    }

    if (confidence >= 75 && !cooldownMap.has(target)) {
      rawAlerts.push({
        target,
        confidence,
        expectedGap,
        expectedRoundsRemaining,
        pureOverdueRatio,
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
    let clusterAnchor = rawAlerts[0].target;

    for (let i = 1; i < rawAlerts.length; i++) {
      const current = rawAlerts[i];

      if (current.target <= clusterAnchor * 1.5) {
        currentCluster.push(current);
      } else {
        clusters.push([...currentCluster]);
        currentCluster = [current];
        clusterAnchor = current.target;
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

      // Fix: Increment signals by total targets in cluster, not just 1
      stats.signals += cluster.length;
      await db
        .update(systemStats)
        .set({ signals: stats.signals })
        .where(eq(systemStats.id, 1));

      const targetsStr = cluster.map((c) => `${c.target}x`).join(", ");
      const avgConfidence = Math.round(
        cluster.reduce((sum, c) => sum + c.confidence, 0) / cluster.length,
      );

      const minRemaining = Math.min(
        ...cluster.map((c) => c.expectedRoundsRemaining),
      );
      const maxRemaining = Math.max(
        ...cluster.map((c) => c.expectedRoundsRemaining),
      );
      const baseExpectedGap = Math.round(
        Math.max(...cluster.map((c) => c.expectedGap)),
      );

      let roundsRange = "";
      let planRounds = 0;

      if (maxRemaining > 0) {
        const lowerLimit = Math.max(1, minRemaining);
        planRounds = maxRemaining;
        roundsRange =
          lowerLimit === planRounds
            ? `Within ${planRounds}`
            : `${lowerLimit} to ${planRounds}`;
      } else {
        planRounds = baseExpectedGap;
        // Fix: Actionable terminology instead of "Plan x"
        roundsRange = `Late: Budget for ${planRounds} bets`;
      }

      const status =
        cluster[0].pureOverdueRatio >= 1.5 ? "Very Overdue" : "Hot & Ready";

      // DB Persistence: Push to pending signals table
      const newSignalsToInsert: {
        id: string | SQL<unknown> | Placeholder<string, any>;
        target: number | SQL<unknown> | Placeholder<string, any>;
        confidence: number | SQL<unknown> | Placeholder<string, any>;
        maxLifespan: number | SQL<unknown> | Placeholder<string, any>;
        roundsElapsed?:
          | number
          | SQL<unknown>
          | Placeholder<string, any>
          | undefined;
      }[] = [];
      cluster.forEach((c) => {
        if (!pendingProofs.find((p) => p.target === c.target)) {
          newSignalsToInsert.push({
            id: c.target.toString(),
            target: c.target,
            confidence: c.confidence,
            roundsElapsed: 0,
            maxLifespan: planRounds + Math.ceil(c.target * 0.85),
          });
        }
      });

      if (newSignalsToInsert.length > 0) {
        await db
          .insert(pendingSignals)
          .values(newSignalsToInsert)
          .onConflictDoNothing();
      }

      // 1. PREMIUM DISPATCH
      if (privateChannelId) {
        const premiumMsg =
          `⚠️ <b>HOT TARGETS FOUND</b>\n\n` +
          `<b>Targets:</b> &gt;${targetsStr}\n\n` +
          `<b>Action Window:</b> ${roundsRange} rounds\n` +
          `<b>Confidence:</b> ${avgConfidence}%\n` +
          `<b>Status:</b> ${status}\n\n` +
          `_Use the bot to plan your bets before you start._`;

        const premiumKb = new InlineKeyboard()
          .url(
            "⚙️ Plan My Bets",
            `https://t.me/${botUsername}?start=strat_${cluster[0].target}`,
          )
          .row()
          .url("❓ Read the Guide", `https://t.me/${botUsername}?start=guide`);

        await bot.api
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
          .url("🤖 Use Bot to Plan Bets", `https://t.me/${botUsername}`)
          .row()
          .url("❓ Read the Guide", `https://t.me/${botUsername}?start=guide`);

        await bot.api
          .sendMessage(publicChannelId, teaseMsg, {
            parse_mode: "HTML",
            reply_markup: publicKb,
          })
          .catch(console.error);
      }
    }
  }

  return rawAlerts;
}
