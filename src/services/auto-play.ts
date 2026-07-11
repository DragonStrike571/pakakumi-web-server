/**
 * Auto-Play Service — Bridges analysis engine correlation clusters to automated bot sessions.
 *
 * Trigger logic:
 * 1. When the analysis engine detects a correlation cluster (≥3 targets),
 *    this module writes an "opportunity" to the auto_play_opportunities table.
 * 2. The local bot polls this table and starts sessions for users with auto-play enabled.
 *
 * Risk management:
 * - 5-10% of capital per play (user-configurable)
 * - Cooldown between plays (default 30 minutes)
 * - Global kill switch via AUTO_PLAY_ENABLED env var
 * - Only triggers on clusters of ≥3 correlated targets
 * - Targets the lower set-target below the median of the cluster
 */

import { db } from "../db/index.js";
import { autoPlayOpportunities } from "../db/schema.js";
import { eq, and, lt } from "drizzle-orm";
import type { AnalysisResult } from "./analysis/engine.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MIN_CLUSTER_SIZE = 3;
const OPPORTUNITY_EXPIRY_MINUTES = 60; // Opportunities expire after 1 hour
const AUTO_PLAY_ENABLED = process.env.AUTO_PLAY_ENABLED !== "false"; // Kill switch

// ─── In-Memory Dedup ────────────────────────────────────────────────────────
// Track recently created opportunities to avoid duplicates within the same cluster lifecycle
const recentOpportunityKeys = new Set<string>();
const MAX_RECENT_KEYS = 100;

function getClusterKey(targets: number[]): string {
  return targets.sort((a, b) => a - b).join(",");
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Process analysis results and create auto-play opportunities from correlation clusters.
 * Called after every analysis engine run.
 */
export async function processAutoPlayOpportunities(
  result: AnalysisResult,
): Promise<void> {
  if (!AUTO_PLAY_ENABLED) return;
  if (result.correlationClusters.length === 0) return;

  for (const cluster of result.correlationClusters) {
    if (cluster.clusterSize < MIN_CLUSTER_SIZE) continue;

    // Dedup: don't create duplicate opportunities for the same cluster
    const key = getClusterKey(cluster.targets);
    if (recentOpportunityKeys.has(key)) continue;

    try {
      const expiresAt = new Date(
        Date.now() + OPPORTUNITY_EXPIRY_MINUTES * 60 * 1000,
      );

      await db.insert(autoPlayOpportunities).values({
        clusterTargets: cluster.targets,
        selectedTarget: cluster.selectedTarget,
        medianTarget: cluster.median,
        clusterSize: cluster.clusterSize,
        avgConfidence: cluster.avgConfidence,
        status: "pending",
        expiresAt,
      });

      // Track this cluster to prevent duplicate inserts
      recentOpportunityKeys.add(key);
      if (recentOpportunityKeys.size > MAX_RECENT_KEYS) {
        const first = recentOpportunityKeys.values().next().value;
        if (first) recentOpportunityKeys.delete(first);
      }

      console.log(
        `🤖 Auto-play opportunity created: targets=[${cluster.targets.join(", ")}] → selected=${cluster.selectedTarget}x (median=${cluster.median}x)`,
      );
    } catch (err) {
      console.error("❌ Error creating auto-play opportunity:", err);
    }
  }
}

/**
 * Expire old opportunities that were never claimed.
 * Called periodically (e.g., every 100 rounds from the engine).
 */
export async function expireStaleOpportunities(): Promise<void> {
  try {
    const now = new Date();
    await db
      .update(autoPlayOpportunities)
      .set({ status: "expired" })
      .where(
        and(
          eq(autoPlayOpportunities.status, "pending"),
          lt(autoPlayOpportunities.expiresAt, now),
        ),
      );
  } catch (err) {
    console.error("❌ Error expiring auto-play opportunities:", err);
  }
}

/**
 * Clear the dedup cache when a correlation cluster resolves (hit or expired).
 * Called when the engine resolves signals that were part of a cluster.
 */
export function clearResolvedCluster(hitTargets: number[]): void {
  if (hitTargets.length === 0) return;

  // Remove any cached keys that contain any of the hit targets
  for (const key of recentOpportunityKeys) {
    const targets = key.split(",").map(Number);
    if (targets.some((t) => hitTargets.includes(t))) {
      recentOpportunityKeys.delete(key);
    }
  }
}
