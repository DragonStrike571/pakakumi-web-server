import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import {
  strategies,
  botSessions,
  strategyAccess,
  pakakumiCredentials,
} from "../db/schema.js";
import { eq, and, desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { trycatch } from "../utils/try-catch.js";
import { requireAuth } from "../middleware/auth.js";
import { AuthenticatedRequest } from "../types/express.js";
import { requireActiveAccess } from "../middleware/access.js";
import rateLimit from "express-rate-limit";
import { encrypt } from "../utils/crypto.js";
import { strategyConfigSchema } from "../validation/strategies.js";
import { requireHealthySource } from "../middleware/source.js";

const router = Router();

router.use(requireAuth);
router.use(requireActiveAccess(true)); // Block telegram_premium users

const botLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

const startBotSchema = z
  .object({
    strategyId: z.uuid(),
    initialCapital: z.number().positive().finite().max(1_000_000_000),
    credentialId: z.string().uuid().optional(),
    auth: z
      .object({
        phone: z.string().trim().min(1).max(50),
        pass: z.string().min(1).max(256),
      })
      .optional(),
  })
  .refine((data) => Boolean(data.credentialId) !== Boolean(data.auth), {
    message: "Provide exactly one of credentialId or auth",
    path: ["auth"],
  });

router.post("/start", botLimiter, requireHealthySource(), async (req: Request, res: Response) => {
  const validation = startBotSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({ error: validation.error.format() });
    return;
  }

  const {
    strategyId,
    initialCapital,
    credentialId,
    auth: rawAuth,
  } = validation.data;
  const userId = (req as AuthenticatedRequest).user.id;

  // Validate a saved credential without decrypting it on the web server. The
  // local worker owns execution and resolves the credential after claiming the
  // session.
  if (credentialId) {
    const { data: cred, error } = await trycatch(async () => {
      return await db.query.pakakumiCredentials.findFirst({
        where: and(
          eq(pakakumiCredentials.id, credentialId),
          eq(pakakumiCredentials.userId, userId),
        ),
      });
    });

    if (error || !cred) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }

  }

  const liveSession = await db.query.botSessions.findFirst({
    where: and(
      eq(botSessions.userId, userId),
      inArray(botSessions.status, ["pending", "starting", "active"]),
    ),
  });
  if (liveSession) {
    res.status(409).json({
      error: "You already have a pending or active bot session.",
      sessionId: liveSession.id,
    });
    return;
  }

  const { data, error } = await trycatch(async () => {
    // 1. Validate strategy access FIRST (before creating any DB records)
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
    if (!strategyConfigSchema.safeParse(strategy.config).success) {
      throw new Error("Strategy configuration is invalid");
    }

    // 2. Only insert session AFTER all validation passes
    const [session] = await db
      .insert(botSessions)
      .values({
        userId,
        strategyId,
        credentialId: credentialId ?? null,
        encryptedPhone: rawAuth ? encrypt(rawAuth.phone) : null,
        encryptedPassword: rawAuth ? encrypt(rawAuth.pass) : null,
        status: "pending",
        initialCapital,
        currentCapital: initialCapital,
        totalProfit: 0,
        currentStep: 0,
        logs: [],
      })
      .returning();

    return session.id;
  });

  if (error) {
    const err = error as Error;
    console.error("Failed to start bot:", err);
    if (err.message === "Strategy not found") {
      res.status(404).json({ error: "Strategy not found" });
    } else if (err.message === "Strategy access denied") {
      res
        .status(403)
        .json({ error: "You do not have access to this strategy" });
    } else if (err.message === "Strategy configuration is invalid") {
      res.status(422).json({ error: err.message });
    } else if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "You already have a live bot session" });
    } else {
      res.status(500).json({ error: err.message || "Failed to start bot" });
    }
    return;
  }

  res.status(201).json({ sessionId: data, status: "starting" });
});

// POST /:sessionId/stop — with ownership check
router.post("/:sessionId/stop", async (req: Request, res: Response) => {
  const parsedSessionId = z.uuid().safeParse(req.params.sessionId);
  if (!parsedSessionId.success) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }
  const sessionId = parsedSessionId.data;
  const userId = (req as AuthenticatedRequest).user.id;

  // Verify ownership
  const session = await db.query.botSessions.findFirst({
    where: and(eq(botSessions.id, sessionId), eq(botSessions.userId, userId)),
  });

  if (!session) {
    res.status(404).json({ error: "Session not found or you do not own it" });
    return;
  }
  if (!["pending", "starting", "active"].includes(session.status)) {
    res.json({ status: session.status });
    return;
  }

  const { error } = await trycatch(async () => {
    return await db
      .update(botSessions)
      .set({
        status: "stopped",
        endedAt: new Date(),
        encryptedPhone: null,
        encryptedPassword: null,
      })
      .where(eq(botSessions.id, sessionId));
  });

  if (error) {
    res.status(500).json({ error: "Internal Error" });
    return;
  }

  res.json({ status: "stopped" });
});

router.get("/status", async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user.id;

  const { data: dbSessions, error } = await trycatch(async () => {
    return await db
      .select({ id: botSessions.id, userId: botSessions.userId, strategyId: botSessions.strategyId,
        status: botSessions.status, initialCapital: botSessions.initialCapital, currentCapital: botSessions.currentCapital,
        totalProfit: botSessions.totalProfit, currentStep: botSessions.currentStep,
        startedAt: botSessions.startedAt, endedAt: botSessions.endedAt })
      .from(botSessions)
      .where(eq(botSessions.userId, userId))
      .orderBy(desc(botSessions.startedAt))
      .limit(100);
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
    status: s.status,
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
