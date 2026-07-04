/**
 * Analysis Engine — Independent of any delivery channel (Telegram, Frontend, etc.)
 *
 * Responsibilities:
 * 1. Calculate signal confidence for all targets based on round history
 * 2. Manage cooldowns with time-based TTL (fixes the "silent death" bug)
 * 3. Generate plain-language explanations for why alerts are sent
 * 4. Persist analysis results for frontend and historical queries
 * 5. Guarantee minimum signal frequency (no silent periods)
 * 6. Track daily prediction stats (EAT timezone)
 * 7. Calculate ideal planning rounds for budget safety
 */

import { db } from "../../db/index.js";
import {
  rounds,
  systemStats,
  pendingSignals,
  signalHistory,
  analysisSnapshots,
  dailyStats,
} from "../../db/schema.js";
import { desc, eq, inArray, sql, lt } from "drizzle-orm";

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

// EAT timezone for daily stats
const EAT_TIMEZONE = "Africa/Nairobi";

// ─── Bandwidth Optimization Constants ───────────────────────────────────────
// These control how often we write to the DB to reduce bandwidth from ~1.5GB/day

const SNAPSHOT_WRITE_INTERVAL = 5; // Write analysisSnapshots every N rounds (was every round)
const DAILY_STATS_FLUSH_INTERVAL = 10; // Flush dailyStats to DB every N rounds (was every event)
const HISTORY_PRUNE_INTERVAL = 500; // Prune old signal_history every N rounds
const HISTORY_RETENTION_DAYS = 30; // Keep signal_history entries for N days

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RawAlert {
  target: number;
  confidence: number;
  expectedGap: number;
  expectedRoundsRemaining: number;
  pureOverdueRatio: number;
  reason: string;
  idealPlanRounds: number;
  isLate: boolean;
}

export interface AlertCluster {
  alerts: RawAlert[];
  targetsStr: string;
  avgConfidence: number;
  minRemaining: number;
  maxRemaining: number;
  roundsRange: string;
  planRounds: number;
  idealPlanRounds: number;
  status: string;
  isLate: boolean;
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
  todayStats: {
    totalPredictions: number;
    totalHits: number;
    totalMisses: number;
    accuracy: number;
  };
  hitTargets: number[];
  deadTargets: number[];
}

export interface CustomAnalysisResult {
  roundCount: number;
  multiplierDistribution: {
    tier: string;
    count: number;
    expected: number;
    status: "hot" | "cold" | "normal";
  }[];
  highest: number;
  lowest: number;
  average: number;
  median: number;
  hotMultipliers: string[];
  coldMultipliers: string[];
}

// ─── State ──────────────────────────────────────────────────────────────────

let cachedRounds: { bust: number; createdAt: Date }[] = [];
let currentRoundIndex = 0;

// Cooldown map with TTL: target → { setAtRound, expiresAtRound }
const cooldownMap = new Map<
  number,
  { setAtRound: number; expiresAtRound: number }
>();

// ─── In-Memory Caches (bandwidth optimization) ──────────────────────────────

// Cached system stats — loaded once from DB, written only when values change
let cachedSystemStats: { id: number; hits: number; signals: number; lastAlertRound: number } | null = null;
let systemStatsDirty = false;

// Cached daily stats — accumulated in memory, flushed periodically
let cachedDailyStats: {
  date: string;
  totalPredictions: number;
  totalHits: number;
  totalMisses: number;
  targets: {
    target: number;
    hit: boolean;
    resolved: boolean;
    roundsToHit?: number;
    createdAt: string;
    resolvedAt?: string;
  }[];
} | null = null;
let dailyStatsDirty = false;

// In-memory pending signals — avoids duplicate SELECTs
let cachedPendingSignals: typeof pendingSignals.$inferSelect[] | null = null;

// Throttle counters
let roundsSinceLastSnapshotWrite = 0;
let roundsSinceLastDailyFlush = 0;
let roundsSinceLastHistoryPrune = 0;

// Last snapshot data for the public accessor to use between DB writes
let lastSnapshotData: {
  activeSignals: any[];
  upcomingOpportunities: any[];
  stats: any;
  updatedAt: Date;
} | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get today's date string in EAT timezone (e.g., "2026-06-27").
 */
function getTodayEAT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: EAT_TIMEZONE });
}

/**
 * Calculate ideal planning rounds for a target.
 * This is the expected duration + a buffer based on the target size.
 * The buffer ensures predictions are more likely to land within the stated range,
 * protecting the platform's prediction legitimacy.
 */
function calculateIdealPlanRounds(
  expectedRoundsRemaining: number,
  target: number,
  isLate: boolean,
): number {
  if (isLate) return 0; // Late status = unpredictable, no ideal calculation
  const buffer = Math.ceil(target / (1 - HOUSE_EDGE));
  return expectedRoundsRemaining + buffer;
}

// ─── Daily Stats Helpers (In-Memory with Periodic Flush) ────────────────────

/**
 * Ensure the in-memory daily stats cache is loaded and current.
 * Loads from DB on first call or day rollover. All subsequent reads are from memory.
 */
async function ensureDailyStatsLoaded(): Promise<void> {
  const today = getTodayEAT();

  if (cachedDailyStats && cachedDailyStats.date === today) {
    return; // Already loaded for today
  }

  // Day rollover or first load — flush any pending data for the old day first
  if (cachedDailyStats && cachedDailyStats.date !== today && dailyStatsDirty) {
    await flushDailyStats();
  }

  try {
    const existing = await db
      .select()
      .from(dailyStats)
      .where(eq(dailyStats.date, today))
      .then((res) => res[0]);

    if (existing) {
      cachedDailyStats = {
        date: today,
        totalPredictions: existing.totalPredictions,
        totalHits: existing.totalHits,
        totalMisses: existing.totalMisses,
        targets: (existing.targets || []) as typeof dailyStats.$inferSelect.targets,
      };
    } else {
      cachedDailyStats = {
        date: today,
        totalPredictions: 0,
        totalHits: 0,
        totalMisses: 0,
        targets: [],
      };
      // Insert the initial row so flushes can UPDATE
      await db.insert(dailyStats).values({
        date: today,
        totalPredictions: 0,
        totalHits: 0,
        totalMisses: 0,
        targets: [],
      });
    }
    dailyStatsDirty = false;
  } catch (err) {
    console.error("❌ Error loading daily stats:", err);
  }
}

/**
 * Flush the in-memory daily stats to the database.
 * Called periodically (every DAILY_STATS_FLUSH_INTERVAL rounds) instead of per-event.
 */
async function flushDailyStats(): Promise<void> {
  if (!cachedDailyStats || !dailyStatsDirty) return;

  try {
    await db
      .update(dailyStats)
      .set({
        totalPredictions: cachedDailyStats.totalPredictions,
        totalHits: cachedDailyStats.totalHits,
        totalMisses: cachedDailyStats.totalMisses,
        targets: cachedDailyStats.targets,
        updatedAt: new Date(),
      })
      .where(eq(dailyStats.date, cachedDailyStats.date));

    dailyStatsDirty = false;
  } catch (err) {
    console.error("❌ Error flushing daily stats:", err);
  }
}

/**
 * Record a prediction in the in-memory daily stats (no DB hit).
 */
function recordDailyPrediction(target: number): void {
  if (!cachedDailyStats) return;

  cachedDailyStats.totalPredictions += 1;
  cachedDailyStats.targets.push({
    target,
    hit: false,
    resolved: false,
    createdAt: new Date().toISOString(),
  });
  dailyStatsDirty = true;
}

/**
 * Record a hit in the in-memory daily stats (no DB hit).
 */
function recordDailyHit(target: number, roundsToHit: number): void {
  if (!cachedDailyStats) return;

  const nowStr = new Date().toISOString();
  const targets = cachedDailyStats.targets;

  for (let i = targets.length - 1; i >= 0; i--) {
    if (targets[i].target === target && !targets[i].resolved) {
      targets[i].hit = true;
      targets[i].resolved = true;
      targets[i].roundsToHit = roundsToHit;
      targets[i].resolvedAt = nowStr;
      break;
    }
  }

  // Keep array bounded
  if (targets.length > 50) {
    targets.splice(0, targets.length - 50);
  }

  cachedDailyStats.totalHits += 1;
  dailyStatsDirty = true;
}

/**
 * Record a miss in the in-memory daily stats (no DB hit).
 */
function recordDailyMiss(target: number): void {
  if (!cachedDailyStats) return;

  const nowStr = new Date().toISOString();
  const targets = cachedDailyStats.targets;

  for (let i = targets.length - 1; i >= 0; i--) {
    if (targets[i].target === target && !targets[i].resolved) {
      targets[i].hit = false;
      targets[i].resolved = true;
      targets[i].resolvedAt = nowStr;
      break;
    }
  }

  // Keep array bounded
  if (targets.length > 50) {
    targets.splice(0, targets.length - 50);
  }

  cachedDailyStats.totalMisses += 1;
  dailyStatsDirty = true;
}

// ─── System Stats Helpers (In-Memory Cache) ─────────────────────────────────

/**
 * Load system stats from DB into memory (once). All subsequent reads are from cache.
 */
async function ensureSystemStatsLoaded(): Promise<void> {
  if (cachedSystemStats) return;

  const row = await db
    .select()
    .from(systemStats)
    .where(eq(systemStats.id, 1))
    .then((res) => res[0]);

  if (row) {
    cachedSystemStats = { ...row };
  } else {
    cachedSystemStats = { id: 1, hits: 0, signals: 0, lastAlertRound: 0 };
    await db.insert(systemStats).values(cachedSystemStats);
  }
  systemStatsDirty = false;
}

/**
 * Flush system stats to DB only if they changed.
 */
async function flushSystemStats(): Promise<void> {
  if (!cachedSystemStats || !systemStatsDirty) return;

  try {
    await db
      .update(systemStats)
      .set({
        signals: cachedSystemStats.signals,
        hits: cachedSystemStats.hits,
        lastAlertRound: cachedSystemStats.lastAlertRound,
      })
      .where(eq(systemStats.id, 1));
    systemStatsDirty = false;
  } catch (err) {
    console.error("❌ Error flushing system stats:", err);
  }
}

// ─── Pending Signals Cache ──────────────────────────────────────────────────

/**
 * Load pending signals from DB into memory (once per engine lifecycle).
 */
async function ensurePendingSignalsLoaded(): Promise<void> {
  if (cachedPendingSignals !== null) return;
  cachedPendingSignals = await db.select().from(pendingSignals);
}

// ─── Signal History Pruning ─────────────────────────────────────────────────

/**
 * Delete resolved signal_history entries older than HISTORY_RETENTION_DAYS.
 * Runs periodically to prevent unbounded table growth.
 */
async function pruneSignalHistory(): Promise<void> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - HISTORY_RETENTION_DAYS);

    const result = await db
      .delete(signalHistory)
      .where(
        sql`${signalHistory.outcome} != 'pending' AND ${signalHistory.createdAt} < ${cutoff}`,
      );

    console.log(`🧹 Pruned signal_history entries older than ${HISTORY_RETENTION_DAYS} days`);
  } catch (err) {
    console.error("❌ Error pruning signal history:", err);
  }
}

// ─── Core Engine ────────────────────────────────────────────────────────────

/**
 * Run the full analysis pipeline. This is the main entry point.
 * Returns raw analysis results that any consumer (Telegram, Frontend, etc.) can use.
 */
export async function runAnalysisEngine(newRound?: {
  bust: number;
  createdAt: Date;
}): Promise<AnalysisResult> {
  // ─── Load persisted state (from cache, not DB) ────────────────────────
  await ensureSystemStatsLoaded();
  const stats = cachedSystemStats!;

  await ensurePendingSignalsLoaded();
  let pendingProofs = cachedPendingSignals!;

  await ensureDailyStatsLoaded();

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
      todayStats: {
        totalPredictions: 0,
        totalHits: 0,
        totalMisses: 0,
        accuracy: 0,
      },
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
      systemStatsDirty = true;

      // Clear from cooldown
      hitTargetsList.forEach((t) => cooldownMap.delete(t));
      await db
        .delete(pendingSignals)
        .where(inArray(pendingSignals.target, hitTargetsList));

      // Remove from in-memory cache
      cachedPendingSignals = cachedPendingSignals!.filter(
        (s) => !hitTargetsList.includes(Number(s.target)),
      );

      // Record outcomes in signal_history and daily stats
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

        recordDailyHit(Number(sig.target), sig.roundsElapsed);
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

      // Remove from in-memory cache
      cachedPendingSignals = cachedPendingSignals!.filter(
        (s) => !deadTargetsList.includes(Number(s.target)),
      );

      // Record misses in signal_history and daily stats
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

        recordDailyMiss(Number(sig.target));
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

      // Update in-memory cache
      for (const s of cachedPendingSignals!) {
        if (survivorTargets.includes(Number(s.target))) {
          s.roundsElapsed += 1;
        }
      }
    }

    // Refresh local reference after mutations
    pendingProofs = cachedPendingSignals!;
  }

  // ─── Step 2: Generate signals ─────────────────────────────────────────
  const roundsSinceLastAlert = currentRoundIndex - stats.lastAlertRound;
  const isDrought = roundsSinceLastAlert >= DROUGHT_ROUND_LIMIT;
  const activeThreshold = isDrought
    ? DROUGHT_CONFIDENCE_THRESHOLD
    : SIGNAL_CONFIDENCE_THRESHOLD;

  // Use a Set for O(1) lookup of pending targets
  const pendingTargetSet = new Set(pendingProofs.map((s) => Number(s.target)));

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
      expectedNextGap = Math.max(
        1,
        expectedTotalForNextGaps - sumOfPreviousGaps,
      );
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

    // Determine if this is a "Late" signal
    const isLate = expectedRoundsRemaining === 0 && pureOverdueRatio >= 1.0;

    // Calculate ideal planning rounds
    const idealPlanRounds = calculateIdealPlanRounds(
      expectedRoundsRemaining,
      target,
      isLate,
    );

    // Generate explanation in plain language
    const reason = generateReason(
      target,
      currentGap,
      expectedGap,
      pureOverdueRatio,
      confidence,
    );

    const alert: RawAlert = {
      target,
      confidence,
      expectedGap,
      expectedRoundsRemaining,
      pureOverdueRatio,
      reason,
      idealPlanRounds,
      isLate,
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
        const cooldownTTL = Math.max(20, Math.round(alert.expectedGap * 1.5));
        cooldownMap.set(alert.target, {
          setAtRound: currentRoundIndex,
          expiresAtRound: currentRoundIndex + cooldownTTL,
        });

        // Insert pending signal if not already tracked
        if (!pendingTargetSet.has(alert.target)) {
          const maxLifespan =
            cluster.planRounds + Math.ceil(alert.target * 0.85);

          const newPendingRow = {
            id: alert.target.toString(),
            target: alert.target,
            confidence: alert.confidence,
            roundsElapsed: 0,
            maxLifespan,
            cooldownExpiry: currentRoundIndex + cooldownTTL,
            reason: alert.reason,
          };

          await db
            .insert(pendingSignals)
            .values(newPendingRow)
            .onConflictDoNothing();

          // Add to in-memory cache
          cachedPendingSignals!.push({
            ...newPendingRow,
            createdAt: new Date(),
          } as typeof pendingSignals.$inferSelect);

          // Record in signal history
          await db.insert(signalHistory).values({
            target: alert.target,
            confidence: alert.confidence,
            reason: alert.reason,
            expectedRoundsRemaining: alert.expectedRoundsRemaining,
            outcome: "pending",
          });

          // Record in daily stats (in-memory, no DB hit)
          recordDailyPrediction(alert.target);

          totalNewSignals++;
        }
      }
    }

    // Update in-memory stats (will be flushed later)
    if (totalNewSignals > 0) {
      stats.signals += totalNewSignals;
      stats.lastAlertRound = currentRoundIndex;
      systemStatsDirty = true;
    }
  }

  // ─── Step 5: Flush dirty caches & throttled writes ────────────────────
  // Flush system stats if dirty (only when values actually changed)
  if (systemStatsDirty) {
    await flushSystemStats();
  }

  // Flush daily stats periodically (not every event)
  roundsSinceLastDailyFlush++;
  if (dailyStatsDirty && roundsSinceLastDailyFlush >= DAILY_STATS_FLUSH_INTERVAL) {
    await flushDailyStats();
    roundsSinceLastDailyFlush = 0;
  }

  // ─── Step 6: Update analysis snapshot (throttled) ─────────────────────
  // Build snapshot from in-memory pending signals (no duplicate DB read)
  const snapshotData = {
    activeSignals: cachedPendingSignals!.map((s) => ({
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
        stats.signals > 0 ? Math.round((stats.hits / stats.signals) * 100) : 0,
      roundsAnalyzed: cachedRounds.length,
    },
  };

  // Always update the in-memory snapshot (for WebSocket broadcasts & API)
  lastSnapshotData = { ...snapshotData, updatedAt: new Date() };

  // Only write to DB every SNAPSHOT_WRITE_INTERVAL rounds
  roundsSinceLastSnapshotWrite++;
  if (roundsSinceLastSnapshotWrite >= SNAPSHOT_WRITE_INTERVAL) {
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
    roundsSinceLastSnapshotWrite = 0;
  }

  // ─── Step 7: Periodic signal_history pruning ──────────────────────────
  roundsSinceLastHistoryPrune++;
  if (roundsSinceLastHistoryPrune >= HISTORY_PRUNE_INTERVAL) {
    await pruneSignalHistory();
    roundsSinceLastHistoryPrune = 0;
  }

  // ─── Step 8: Get today's stats (from memory) ──────────────────────────
  const todayStats = getTodayStatsFromCache();

  return {
    alerts: rawAlerts,
    clusters,
    upcomingOpportunities,
    stats: snapshotData.stats,
    todayStats,
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

  const minRemaining = Math.min(
    ...alerts.map((c) => c.expectedRoundsRemaining),
  );
  const maxRemaining = Math.max(
    ...alerts.map((c) => c.expectedRoundsRemaining),
  );
  const baseExpectedGap = Math.round(
    Math.max(...alerts.map((c) => c.expectedGap)),
  );

  // Check if all alerts are "Late"
  const allLate = alerts.every((a) => a.isLate);
  const isLate = allLate && maxRemaining === 0;

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

  // Calculate ideal plan rounds for the cluster
  // Use the maximum idealPlanRounds from all alerts in the cluster
  const idealPlanRounds = isLate
    ? 0
    : Math.max(...alerts.map((a) => a.idealPlanRounds));

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
    idealPlanRounds,
    status,
    isLate,
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

// ─── Custom Analysis (for /analyze command) ─────────────────────────────────

/**
 * Analyze a specific range of cached rounds for multiplier patterns.
 * Used by the /analyze command.
 */
export function runCustomAnalysis(
  roundCount: number,
  startOffset: number = 0,
): CustomAnalysisResult | null {
  if (cachedRounds.length === 0) return null;

  const endIdx = cachedRounds.length - startOffset;
  const startIdx = Math.max(0, endIdx - roundCount);

  if (endIdx <= 0 || startIdx >= endIdx) return null;

  const slice = cachedRounds.slice(startIdx, endIdx);
  const busts = slice.map((r) => r.bust);

  if (busts.length === 0) return null;

  // Multiplier distribution tiers
  const tiers = [
    { label: "1x–1.99x", min: 1, max: 2 },
    { label: "2x–4.99x", min: 2, max: 5 },
    { label: "5x–9.99x", min: 5, max: 10 },
    { label: "10x–24.99x", min: 10, max: 25 },
    { label: "25x–49.99x", min: 25, max: 50 },
    { label: "50x–99.99x", min: 50, max: 100 },
    { label: "100x–499.99x", min: 100, max: 500 },
    { label: "500x+", min: 500, max: Infinity },
  ];

  const distribution = tiers.map((tier) => {
    const count = busts.filter((b) => b >= tier.min && b < tier.max).length;
    // Expected probability for each tier using house edge
    const probMin = (1 - HOUSE_EDGE) / tier.min;
    const probMax = tier.max === Infinity ? 0 : (1 - HOUSE_EDGE) / tier.max;
    const expectedProb = probMin - probMax;
    const expected = Math.round(expectedProb * busts.length);

    let status: "hot" | "cold" | "normal" = "normal";
    if (expected > 0) {
      const ratio = count / expected;
      if (ratio >= 1.3) status = "hot";
      else if (ratio <= 0.7) status = "cold";
    }

    return { tier: tier.label, count, expected, status };
  });

  // Hot and cold multipliers (specific TARGETS)
  const hotMultipliers: string[] = [];
  const coldMultipliers: string[] = [];

  for (const target of TARGETS) {
    if (target > 500) continue; // Skip extremely rare targets for this analysis
    const expectedGap = target / (1 - HOUSE_EDGE);
    const expectedCount = busts.length / expectedGap;
    if (expectedCount < 1) continue; // Not enough rounds for meaningful analysis

    const actualCount = busts.filter((b) => b >= target).length;
    const ratio = actualCount / expectedCount;

    if (ratio >= 1.4)
      hotMultipliers.push(
        `${target}x (${actualCount} times vs ~${Math.round(expectedCount)} expected)`,
      );
    else if (ratio <= 0.6 && expectedCount >= 2)
      coldMultipliers.push(
        `${target}x (${actualCount} times vs ~${Math.round(expectedCount)} expected)`,
      );
  }

  const sorted = [...busts].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

  return {
    roundCount: busts.length,
    multiplierDistribution: distribution,
    highest: Math.max(...busts),
    lowest: Math.min(...busts),
    average:
      Math.round((busts.reduce((s, b) => s + b, 0) / busts.length) * 100) / 100,
    median: Math.round(median * 100) / 100,
    hotMultipliers: hotMultipliers.slice(0, 5),
    coldMultipliers: coldMultipliers.slice(0, 5),
  };
}

// ─── Public Accessors ───────────────────────────────────────────────────────

/**
 * Get the current analysis snapshot.
 * Returns from in-memory cache first (always fresh), falls back to DB.
 */
export async function getAnalysisSnapshot() {
  if (lastSnapshotData) {
    return lastSnapshotData;
  }

  // Fallback to DB (only on first call before engine has run)
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
 * Returns from in-memory cache if available.
 */
export async function getSystemStats() {
  if (cachedSystemStats) {
    return cachedSystemStats;
  }

  return await db
    .select()
    .from(systemStats)
    .where(eq(systemStats.id, 1))
    .then((res) => res[0] || null);
}

/**
 * Get today's stats from in-memory cache (no DB hit).
 * Used internally by the engine.
 */
function getTodayStatsFromCache(): {
  totalPredictions: number;
  totalHits: number;
  totalMisses: number;
  accuracy: number;
} {
  if (!cachedDailyStats) {
    return { totalPredictions: 0, totalHits: 0, totalMisses: 0, accuracy: 0 };
  }

  const resolved = cachedDailyStats.totalHits + cachedDailyStats.totalMisses;
  const accuracy =
    resolved > 0 ? Math.round((cachedDailyStats.totalHits / resolved) * 100) : 0;

  return {
    totalPredictions: cachedDailyStats.totalPredictions,
    totalHits: cachedDailyStats.totalHits,
    totalMisses: cachedDailyStats.totalMisses,
    accuracy,
  };
}

/**
 * Get today's stats (EAT timezone).
 * Public API — returns from cache if available, otherwise DB.
 */
export async function getTodayStats(): Promise<{
  totalPredictions: number;
  totalHits: number;
  totalMisses: number;
  accuracy: number;
  targets?: typeof dailyStats.$inferSelect.targets;
}> {
  // If in-memory cache is loaded, return from it
  if (cachedDailyStats && cachedDailyStats.date === getTodayEAT()) {
    const resolved = cachedDailyStats.totalHits + cachedDailyStats.totalMisses;
    const accuracy =
      resolved > 0 ? Math.round((cachedDailyStats.totalHits / resolved) * 100) : 0;

    return {
      totalPredictions: cachedDailyStats.totalPredictions,
      totalHits: cachedDailyStats.totalHits,
      totalMisses: cachedDailyStats.totalMisses,
      accuracy,
      targets: cachedDailyStats.targets,
    };
  }

  // Fallback to DB (before engine has initialized)
  const today = getTodayEAT();
  const row = await db
    .select()
    .from(dailyStats)
    .where(eq(dailyStats.date, today))
    .then((res) => res[0]);

  if (!row) {
    return { totalPredictions: 0, totalHits: 0, totalMisses: 0, accuracy: 0 };
  }

  const resolved = row.totalHits + row.totalMisses;
  const accuracy =
    resolved > 0 ? Math.round((row.totalHits / resolved) * 100) : 0;

  return {
    totalPredictions: row.totalPredictions,
    totalHits: row.totalHits,
    totalMisses: row.totalMisses,
    accuracy,
    targets: row.targets,
  };
}

/**
 * Expose the free channel confidence threshold for consumers.
 */
export { FREE_CHANNEL_CONFIDENCE_THRESHOLD };
