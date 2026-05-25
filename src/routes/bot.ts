import { Router, Request, Response } from "express";
import { botManager } from "../services/bot/manager.js";
import { db } from "../db/index.js";
import { strategies, botSessions, strategyAccess } from "../db/schema.js";
import { eq, and, or, exists, desc } from "drizzle-orm";
import { z } from "zod";
import { trycatch } from "../utils/try-catch.js";
import { requireAuth } from "../middleware/auth.js";
import { AuthenticatedRequest } from "../types/express.js";

const router = Router();

router.use(requireAuth);

const startBotSchema = z.object({
  strategyId: z.uuid(),
  initialCapital: z.number().positive(),
  auth: z.object({
    phone: z.string().min(1),
    pass: z.string().min(1),
  }),
});

router.post("/start", async (req: Request, res: Response) => {
  const validation = startBotSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({ error: validation.error.format() });
    return;
  }

  const { strategyId, initialCapital, auth } = validation.data;
  const userId = (req as AuthenticatedRequest).user.id;

  // Check concurrency limit
  const activeSessions = botManager.getActiveSessionsForUser(userId);
  if (activeSessions.length >= 1) {
    res.status(429).json({ error: "User already has an active bot session." });
    return;
  }

  const { data, error } = await trycatch(async () => {
    const { data: strategy, error: strategyError } = await trycatch(
      async () => {
        return await db.query.strategies.findFirst({
          where: eq(strategies.id, strategyId),
        });
      },
    );

    if (strategyError) {
      console.error("Error fetching strategy:", strategyError);
      throw new Error("Failed to fetch strategy");
    }

    if (!strategy) {
      throw new Error("Strategy not found");
    }

    // Allow owner or users with shared access
    const isOwner = strategy.userId === userId;
    let hasAccess = isOwner;

    if (!isOwner) {
      // Check if strategy is public or shared with this user
      if (strategy.visibility === "public") {
        hasAccess = true;
      } else {
        const { data: shared } = await trycatch(async () => {
          const access = await db
            .select()
            .from(strategyAccess)
            .where(
              and(
                eq(strategyAccess.strategyId, strategyId),
                eq(strategyAccess.userId, userId),
              ),
            )
            .limit(1);
          return access.length > 0;
        });
        if (shared) hasAccess = true;
      }
    }

    if (!hasAccess) {
      throw new Error("Strategy access denied");
    }

    const sessionId = await botManager.startSession(
      userId,
      strategyId,
      strategy.config as any,
      initialCapital,
      auth,
    );

    return sessionId;
  });

  if (error) {
    const err = error as Error;
    console.error("Failed to start bot:", err);
    if (err.message === "Strategy not found") {
      res.status(404).json({ error: "Strategy not found" });
    } else if (err.message === "Strategy access denied") {
      res.status(403).json({ error: "You do not have access to this strategy" });
    } else {
      res.status(500).json({ error: err.message || "Failed to start bot" });
    }
    return;
  }

  res.status(201).json({ sessionId: data, status: "starting" });
});

// POST /:sessionId/stop — with ownership check
router.post("/:sessionId/stop", async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const userId = (req as AuthenticatedRequest).user.id;

  // Verify ownership: only the session owner can stop it
  const session = botManager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found or already stopped" });
    return;
  }

  if (session.userId !== userId) {
    res.status(403).json({ error: "You do not own this session" });
    return;
  }

  const { data: stopped, error } = await trycatch(async () => {
    return await botManager.stopSession(sessionId as string);
  });

  if (error) {
    res.status(500).json({ error: "Internal Error" });
    return;
  }

  if (stopped) {
    res.json({ status: "stopped" });
  } else {
    res.status(404).json({ error: "Session not found or already stopped" });
  }
});

router.get("/status", async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user.id;

  // Get in-memory active session IDs
  const activeSessions = botManager.getActiveSessionsForUser(userId);
  const activeIds = new Set(activeSessions.map((s) => s.sessionId));

  // Fetch full session details from DB
  const { data: dbSessions, error } = await trycatch(async () => {
    return await db
      .select()
      .from(botSessions)
      .where(eq(botSessions.userId, userId))
      .orderBy(desc(botSessions.startedAt));
  });

  if (error) {
    console.error("Error fetching bot sessions:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
    return;
  }

  const result = (dbSessions || []).map((s) => ({
    sessionId: s.id,
    userId: s.userId,
    strategyId: s.strategyId,
    status: activeIds.has(s.id) ? "running" : s.status,
    initialCapital: s.initialCapital,
    currentCapital: s.currentCapital,
    totalProfit: s.totalProfit,
    currentStep: s.currentStep,
    createdAt: s.startedAt,
    stoppedAt: s.endedAt,
  }));

  res.json(result);
});

export default router;
