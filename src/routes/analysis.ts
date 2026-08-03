/**
 * Analysis API — Exposes analysis data to the frontend.
 *
 * Endpoints:
 * - GET /analysis/current   — Current active signals + upcoming opportunities
 * - GET /analysis/history   — Paginated signal history with outcomes
 * - GET /analysis/stats     — System accuracy & performance stats
 */

import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { signalHistory } from "../db/schema.js";
import { desc, count, eq } from "drizzle-orm";
import { trycatch } from "../utils/try-catch.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getAnalysisSnapshot,
  getSignalHistory,
  getSystemStats,
} from "../services/analysis/engine.js";
import { z } from "zod";
import { requireActiveAccess } from "../middleware/access.js";

const router = Router();

// All analysis endpoints require authentication
router.use(requireAuth);
router.use(requireActiveAccess());

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
        totalSignals: 0,
        totalHits: 0,
        accuracy: 0,
        roundsAnalyzed: 0,
      },
      updatedAt: null,
    });
  }

  res.json({
    activeSignals: snapshot.activeSignals || [],
    upcomingOpportunities: snapshot.upcomingOpportunities || [],
    stats: snapshot.stats || {
      totalSignals: 0,
      totalHits: 0,
      accuracy: 0,
      roundsAnalyzed: 0,
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
  page: z.coerce.number().int().min(1).default(1),
  outcome: z.enum(["hit", "missed", "pending"]).optional(),
});

router.get("/history", async (req: Request, res: Response) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  const { limit, page, outcome } = parsed.data;
  const offset = (page - 1) * limit;

  const { data, error } = await trycatch(async () => {
    const whereCondition = outcome
      ? eq(signalHistory.outcome, outcome)
      : undefined;

    const [history, [totalCount]] = await Promise.all([
      db
        .select()
        .from(signalHistory)
        .where(whereCondition)
        .orderBy(desc(signalHistory.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(signalHistory)
        .where(whereCondition),
    ]);

    return {
      data: history,
      pagination: {
        total: totalCount?.count || 0,
        page,
        limit,
        totalPages: Math.ceil((totalCount?.count || 0) / limit),
      },
    };
  });

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
      totalSignals: 0,
      totalHits: 0,
      accuracy: 0,
      lastAlertRound: 0,
    });
  }

  const accuracy =
    stats.signals > 0
      ? Math.round((stats.hits / stats.signals) * 100)
      : 0;

  res.json({
    totalSignals: stats.signals,
    totalHits: stats.hits,
    accuracy,
    lastAlertRound: stats.lastAlertRound,
  });
});

export default router;
