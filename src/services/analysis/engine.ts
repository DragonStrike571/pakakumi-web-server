/**
 * Analysis Engine — Independent of any delivery channel (Telegram, Frontend, etc.)
 *
 * Responsibilities:
 * 1. Calculate signal confidence for all targets based on round history
 * 2. Manage cooldowns with time-based TTL (fixes the "silent death" bug)
 * 3. Generate plain-language explanations for why alerts are sent
 * 4. Persist analysis results for frontend and historical queries
 * 5. Guarantee minimum signal frequency (no silent periods)
 */

import { db } from "../../db/index.js";
import {
  rounds,
  systemStats,
  pendingSignals,
  signalHistory,
  analysisSnapshots,
} from "../../db/schema.js";
import { desc, eq, inArray, sql } from "drizzle-orm";

// ─── Constants ──────────────────────────────────────────────────────────────

const HOUSE_EDGE = 0.01; // 1%
const TARGETS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90,
  100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1500,
  2000, 2500, 3000,
];

const SIGNAL_CONFIDENCE_THRESHOLD = 70;
const FREE_CHANNEL_CONFIDENCE_THRESHOLD = 90;
const DROUGHT_ROUND_LIMIT = 100; // force-scan at lower threshold after this many silent rounds
const DROUGHT_CONFIDENCE_THRESHOLD = 60;
const K_OCCURRENCES = 5; // how many past occurrences to use for gap calculation

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RawAlert {
  target: number;
  confidence: number;
  expectedGap: number;
  expectedRoundsRemaining: number;
  pureOverdueRatio: number;
  reason: string;
}

export interface AlertCluster {
  alerts: RawAlert[];
  targetsStr: string;
  avgConfidence: number;
  minRemaining: number;
  maxRemaining: number;
  roundsRange: string;
  planRounds: number;
  status: string;
}

export interface AnalysisResult {
  alerts: RawAlert[];
  clusters: AlertCluster[];
  upcomingOpportunities: RawAlert[];
  stats: {
    totalSignals: number;
    totalHits: number;
    accuracy: number;
    roundsAnalyzed: number;
  };
  hitTargets: number[];
  deadTargets: number[];
}

// ─── State ──────────────────────────────────────────────────────────────────

let cachedRounds: { bust: number; createdAt: Date }[] = [];
let currentRoundIndex = 0;

// Cooldown map with TTL: target → { setAtRound, expiresAtRound }
const cooldownMap = new Map<
  number,
  { setAtRound: number; expiresAtRound: number }
>();

// ─── Core Engine ────────────────────────────────────────────────────────────

/**
 * Run the full analysis pipeline. This is the main entry point.
 * Returns raw analysis results that any consumer (Telegram, Frontend, etc.) can use.
 */
export async function runAnalysisEngine(newRound?: {
  bust: number;
  createdAt: Date;
}): Promise<AnalysisResult> {
  // ─── Load persisted state ─────────────────────────────────────────────
  let stats = await db
    .select()
    .from(systemStats)
    .where(eq(systemStats.id, 1))
    .then((res) => res[0]);

  if (!stats) {
    stats = { id: 1, hits: 0, signals: 0, lastAlertRound: 0 };
    await db.insert(systemStats).values(stats);
  }

  let pendingProofs = await db.select().from(pendingSignals);

  // ─── Load round cache ─────────────────────────────────────────────────
  if (cachedRounds.length === 0) {
    const latestRounds = await db.query.rounds.findMany({
      orderBy: [desc(rounds.createdAt)],
      limit: 10000,
      columns: { bust: true, createdAt: true },
    });
    cachedRounds = latestRounds.reverse();
    currentRoundIndex = cachedRounds.length;
  }

  if (newRound) {
    cachedRounds.push(newRound);
    if (cachedRounds.length > 11000) {
      cachedRounds = cachedRounds.slice(cachedRounds.length - 10000);
    }
    currentRoundIndex++;
  }

  if (cachedRounds.length === 0) {
    return {
      alerts: [],
      clusters: [],
      upcomingOpportunities: [],
      stats: { totalSignals: 0, totalHits: 0, accuracy: 0, roundsAnalyzed: 0 },
      hitTargets: [],
      deadTargets: [],
    };
  }

  // ─── Expire stale cooldowns ───────────────────────────────────────────
  for (const [target, cd] of cooldownMap.entries()) {
    if (currentRoundIndex >= cd.expiresAtRound) {
      cooldownMap.delete(target);
    }
  }

  // ─── Step 1: Evaluate pending signals against new round ───────────────
  let hitTargetsList: number[] = [];
  let deadTargetsList: number[] = [];

  if (newRound && pendingProofs.length > 0) {
    // Process hits
    const hitSignals = pendingProofs.filter(
      (s) => newRound.bust >= Number(s.target),
    );

    if (hitSignals.length > 0) {
      hitTargetsList = hitSignals.map((s) => Number(s.target));
      stats.hits += hitSignals.length;

      // Clear from cooldown
      hitTargetsList.forEach((t) => cooldownMap.delete(t));
      await db
        .delete(pendingSignals)
        .where(inArray(pendingSignals.target, hitTargetsList));

      // Record outcomes in signal_history
      for (const sig of hitSignals) {
        await db
          .update(signalHistory)
          .set({
            outcome: "hit",
            bustValue: newRound.bust,
            actualRoundsToHit: sig.roundsElapsed,
            resolvedAt: new Date(),
          })
          .where(
            sql`${signalHistory.target} = ${Number(sig.target)} AND ${signalHistory.outcome} = 'pending'`,
          );
      }
    }

    // Process expired/dead signals
    const deadSignals = pendingProofs.filter(
      (s) =>
        newRound.bust < Number(s.target) &&
        s.roundsElapsed + 1 >= s.maxLifespan,
    );

    if (deadSignals.length > 0) {
      deadTargetsList = deadSignals.map((s) => Number(s.target));
      deadTargetsList.forEach((t) => cooldownMap.delete(t));
      await db
        .delete(pendingSignals)
        .where(inArray(pendingSignals.target, deadTargetsList));

      // Record misses in signal_history
      for (const sig of deadSignals) {
        await db
          .update(signalHistory)
          .set({
            outcome: "missed",
            resolvedAt: new Date(),
            actualRoundsToHit: sig.roundsElapsed,
          })
          .where(
            sql`${signalHistory.target} = ${Number(sig.target)} AND ${signalHistory.outcome} = 'pending'`,
          );
      }
    }

    // Update elapsed rounds for survivors
    const survivorTargets = pendingProofs
      .map((s) => Number(s.target))
      .filter(
        (t) => !hitTargetsList.includes(t) && !deadTargetsList.includes(t),
      );

    if (survivorTargets.length > 0) {
      await db
        .update(pendingSignals)
        .set({ roundsElapsed: sql`${pendingSignals.roundsElapsed} + 1` })
        .where(inArray(pendingSignals.target, survivorTargets));
    }
  }

  // ─── Step 2: Generate signals ─────────────────────────────────────────
  const roundsSinceLastAlert = currentRoundIndex - stats.lastAlertRound;
  const isDrought = roundsSinceLastAlert >= DROUGHT_ROUND_LIMIT;
  const activeThreshold = isDrought
    ? DROUGHT_CONFIDENCE_THRESHOLD
    : SIGNAL_CONFIDENCE_THRESHOLD;

  // Use a Set for O(1) lookup of pending targets
  const pendingTargetSet = new Set(
    pendingProofs.map((s) => Number(s.target)),
  );

  const rawAlerts: RawAlert[] = [];
  const upcomingOpportunities: RawAlert[] = [];

  for (const target of TARGETS) {
    const expectedGap = target / (1 - HOUSE_EDGE);
    const occIndices: number[] = [];

    // Traverse BACKWARDS since end of array is the newest
    for (let i = cachedRounds.length - 1; i >= 0; i--) {
      if (cachedRounds[i].bust >= target) {
        const distance = cachedRounds.length - 1 - i;
        occIndices.push(distance);
        if (occIndices.length >= K_OCCURRENCES + 1) break;
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
      expectedNextGap = Math.max(1, expectedTotalForNextGaps - sumOfPreviousGaps);
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

    // Generate explanation in plain language
    const reason = generateReason(target, currentGap, expectedGap, pureOverdueRatio, confidence);

    const alert: RawAlert = {
      target,
      confidence,
      expectedGap,
      expectedRoundsRemaining,
      pureOverdueRatio,
      reason,
    };

    // Collect upcoming opportunities (50-69% confidence) for frontend display
    if (confidence >= 50 && confidence < activeThreshold) {
      upcomingOpportunities.push(alert);
    }

    // Only generate actionable alerts above threshold
    if (confidence >= activeThreshold && !cooldownMap.has(target)) {
      rawAlerts.push(alert);
    }
  }

  // ─── Step 3: Cluster alerts ───────────────────────────────────────────
  const clusters: AlertCluster[] = [];
  rawAlerts.sort((a, b) => a.target - b.target);

  if (rawAlerts.length > 0) {
    let currentCluster = [rawAlerts[0]];
    let clusterAnchor = rawAlerts[0].target;

    for (let i = 1; i < rawAlerts.length; i++) {
      const current = rawAlerts[i];
      if (current.target <= clusterAnchor * 1.5) {
        currentCluster.push(current);
      } else {
        clusters.push(buildCluster(currentCluster));
        currentCluster = [current];
        clusterAnchor = current.target;
      }
    }
    if (currentCluster.length > 0) {
      clusters.push(buildCluster(currentCluster));
    }
  }

  // ─── Step 4: Persist signals and update stats ─────────────────────────
  if (clusters.length > 0) {
    let totalNewSignals = 0;

    for (const cluster of clusters) {
      for (const alert of cluster.alerts) {
        // Set cooldown with TTL based on expected gap
        const cooldownTTL = Math.max(
          20,
          Math.round(alert.expectedGap * 1.5),
        );
        cooldownMap.set(alert.target, {
          setAtRound: currentRoundIndex,
          expiresAtRound: currentRoundIndex + cooldownTTL,
        });

        // Insert pending signal if not already tracked
        if (!pendingTargetSet.has(alert.target)) {
          const maxLifespan =
            cluster.planRounds + Math.ceil(alert.target * 0.85);

          await db
            .insert(pendingSignals)
            .values({
              id: alert.target.toString(),
              target: alert.target,
              confidence: alert.confidence,
              roundsElapsed: 0,
              maxLifespan,
              cooldownExpiry: currentRoundIndex + cooldownTTL,
              reason: alert.reason,
            })
            .onConflictDoNothing();

          // Record in signal history
          await db.insert(signalHistory).values({
            target: alert.target,
            confidence: alert.confidence,
            reason: alert.reason,
            expectedRoundsRemaining: alert.expectedRoundsRemaining,
            outcome: "pending",
          });

          totalNewSignals++;
        }
      }
    }

    // Batch update stats once at the end
    if (totalNewSignals > 0) {
      stats.signals += totalNewSignals;
      stats.lastAlertRound = currentRoundIndex;
      await db
        .update(systemStats)
        .set({
          signals: stats.signals,
          hits: stats.hits,
          lastAlertRound: stats.lastAlertRound,
        })
        .where(eq(systemStats.id, 1));
    }
  } else if (hitTargetsList.length > 0) {
    // Still update hits even if no new clusters
    await db
      .update(systemStats)
      .set({ hits: stats.hits })
      .where(eq(systemStats.id, 1));
  }

  // ─── Step 5: Update analysis snapshot for frontend ────────────────────
  const refreshedPending = await db.select().from(pendingSignals);

  const snapshotData = {
    activeSignals: refreshedPending.map((s) => ({
      target: Number(s.target),
      confidence: s.confidence,
      expectedRoundsRemaining: Math.max(0, s.maxLifespan - s.roundsElapsed),
      status:
        s.roundsElapsed > s.maxLifespan * 0.8
          ? "Late — still waiting"
          : "Active — watching",
      reason: s.reason || "",
      roundsElapsed: s.roundsElapsed,
    })),
    upcomingOpportunities: upcomingOpportunities
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10)
      .map((o) => ({
        target: o.target,
        confidence: o.confidence,
        expectedRoundsRemaining: o.expectedRoundsRemaining,
        reason: o.reason,
      })),
    stats: {
      totalSignals: stats.signals,
      totalHits: stats.hits,
      accuracy:
        stats.signals > 0
          ? Math.round((stats.hits / stats.signals) * 100)
          : 0,
      roundsAnalyzed: cachedRounds.length,
    },
  };

  await db
    .insert(analysisSnapshots)
    .values({
      id: 1,
      ...snapshotData,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: analysisSnapshots.id,
      set: { ...snapshotData, updatedAt: new Date() },
    });

  return {
    alerts: rawAlerts,
    clusters,
    upcomingOpportunities,
    stats: snapshotData.stats,
    hitTargets: hitTargetsList,
    deadTargets: deadTargetsList,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildCluster(alerts: RawAlert[]): AlertCluster {
  const targetsStr = alerts.map((c) => `${c.target}x`).join(", ");
  const avgConfidence = Math.round(
    alerts.reduce((sum, c) => sum + c.confidence, 0) / alerts.length,
  );

  const minRemaining = Math.min(...alerts.map((c) => c.expectedRoundsRemaining));
  const maxRemaining = Math.max(...alerts.map((c) => c.expectedRoundsRemaining));
  const baseExpectedGap = Math.round(
    Math.max(...alerts.map((c) => c.expectedGap)),
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
    roundsRange = `Late: Budget for ${planRounds} bets`;
  }

  const status =
    alerts[0].pureOverdueRatio >= 1.5 ? "Very Overdue" : "Hot & Ready";

  return {
    alerts,
    targetsStr,
    avgConfidence,
    minRemaining,
    maxRemaining,
    roundsRange,
    planRounds,
    status,
  };
}

/**
 * Generate a plain-language explanation for why a signal is being generated.
 * Written for standard Kenyan users — no jargon, clear and direct.
 */
function generateReason(
  target: number,
  currentGap: number,
  expectedGap: number,
  overdueRatio: number,
  confidence: number,
): string {
  const expectedGapRounded = Math.round(expectedGap);

  if (overdueRatio >= 2.0) {
    return (
      `${target}x has not appeared in the last ${currentGap} games. ` +
      `Normally it shows up every ${expectedGapRounded} games. ` +
      `It is very overdue — the game usually corrects this kind of delay.`
    );
  }

  if (overdueRatio >= 1.5) {
    return (
      `${target}x last appeared ${currentGap} games ago. ` +
      `The average gap is ${expectedGapRounded} games. ` +
      `It is overdue and could drop soon.`
    );
  }

  if (overdueRatio >= 1.0) {
    return (
      `${target}x is approaching its expected timing. ` +
      `It has been ${currentGap} games since the last hit (average is ${expectedGapRounded}). ` +
      `The pattern says it is getting close.`
    );
  }

  return (
    `${target}x is building up. ` +
    `${currentGap} games since the last one (normally every ${expectedGapRounded}). ` +
    `Confidence is at ${confidence}%.`
  );
}

/**
 * Get the current analysis snapshot from the database.
 * Used by the REST API for frontend access.
 */
export async function getAnalysisSnapshot() {
  return await db
    .select()
    .from(analysisSnapshots)
    .where(eq(analysisSnapshots.id, 1))
    .then((res) => res[0] || null);
}

/**
 * Get signal history with pagination.
 */
export async function getSignalHistory(limit = 50, offset = 0) {
  return await db
    .select()
    .from(signalHistory)
    .orderBy(desc(signalHistory.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get current system stats.
 */
export async function getSystemStats() {
  return await db
    .select()
    .from(systemStats)
    .where(eq(systemStats.id, 1))
    .then((res) => res[0] || null);
}

/**
 * Expose the free channel confidence threshold for consumers.
 */
export { FREE_CHANNEL_CONFIDENCE_THRESHOLD };
