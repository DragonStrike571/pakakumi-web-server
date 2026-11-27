/**
 * Analysis API — Exposes analysis data to the frontend.
 *
 * Endpoints:
 * - GET /analysis/current   — Current active signals + upcoming opportunities
 * - GET /analysis/history   — Paginated signal history with outcomes
 * - GET /analysis/stats     — System accuracy & performance stats
 */

import { Router, Request, Response } from "express";
import { trycatch } from "../utils/try-catch.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getAnalysisSnapshot,
  getSignalHistory,
  signalTotals,
  getSystemStats,
} from "../services/analysis/engine.js";
import { z } from "zod";
import { requireActiveAccess } from "../middleware/access.js";
import { getGapAnalysis } from "../services/analysis-gaps.js";
import rateLimit from "express-rate-limit";
import type { AuthenticatedRequest } from "../types/express.js";

const router = Router();

// All analysis endpoints require authentication
router.use(requireAuth);
router.use(requireActiveAccess());

const gapQuery = z.object({ target: z.coerce.number().gt(1).finite().max(1_000_000).default(100), pointLimit: z.coerce.number().int().min(2).max(50).default(25) });
router.get("/gaps", rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: req => (req as AuthenticatedRequest).user.id }), async (req, res) => {
  const parsed = gapQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  try { res.json(await getGapAnalysis(parsed.data.target, parsed.data.pointLimit)); }
  catch (error) { console.error("Target gap query failed:", error); res.status(503).json({ error: "Target gap analysis is temporarily unavailable. Please retry." }); }
});

/**
 * GET /analysis/current
 * Returns the latest analysis snapshot: active signals, upcoming opportunities, and stats.
 */
router.get("/current", async (req: Request, res: Response) => {
  const { data: snapshot, error } = await trycatch(async () => {
    return await getAnalysisSnapshot();
  });

  if (error) {
    console.error("Error fetching analysis snapshot:", error);
    return res.status(500).json({ error: "Failed to fetch analysis data" });
  }

  if (!snapshot) {
    return res.json({
      activeSignals: [],
      upcomingOpportunities: [],
      stats: {
        ...signalTotals(0, 0, 0),
        roundsAnalyzed: 0,
      },
      updatedAt: null,
    });
  }

  res.json({
    activeSignals: snapshot.activeSignals || [],
    upcomingOpportunities: snapshot.upcomingOpportunities || [],
    stats: {
      roundsAnalyzed: snapshot.stats?.roundsAnalyzed ?? 0,
      ...signalTotals(snapshot.stats?.totalHits ?? 0, snapshot.stats?.totalSignals ?? 0, snapshot.activeSignals?.length ?? 0),
    },
    updatedAt: snapshot.updatedAt,
  });
});

/**
 * GET /analysis/history
 * Returns paginated signal history with outcomes.
 * Query params: ?limit=50&page=1&outcome=hit|missed|pending
 */
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  target: z.coerce.number().finite().gt(1).max(1_000_000).optional(),
  outcome: z.enum(["hit", "missed", "pending"]).optional(),
});

router.get("/history", async (req: Request, res: Response) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  const { limit, page, outcome, target } = parsed.data;
  const { data, error } = await trycatch(() => getSignalHistory(limit, page, outcome, target));

  if (error) {
    console.error("Error fetching signal history:", error);
    return res.status(500).json({ error: "Failed to fetch signal history" });
  }

  res.json(data);
});

/**
 * GET /analysis/stats
 * Returns system-wide stats: total signals, hits, accuracy, rounds analyzed.
 */
router.get("/stats", async (req: Request, res: Response) => {
  const { data: stats, error } = await trycatch(async () => {
    return await getSystemStats();
  });

  if (error) {
    console.error("Error fetching system stats:", error);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }

  if (!stats) {
    return res.json({
      ...signalTotals(0, 0, 0),
      lastAlertRound: 0,
    });
  }

  res.json({
    ...signalTotals(stats.hits, stats.signals, stats.pending),
    lastAlertRound: stats.lastAlertRound,
  });
});

export default router;
