import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { strategies, strategyAccess, users } from "../db/schema.js";
import { eq, desc, or, and, exists } from "drizzle-orm";
import {
  createStrategySchema,
  updateStrategySchema,
} from "../validation/strategies.js";
import { trycatch } from "../utils/try-catch.js";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AuthenticatedRequest } from "../types/express.js";

const router = Router();

router.use(requireAuth);

const strategyIdSchema = z.object({
  id: z.uuid(),
});

// GET all strategies for a user
router.get("/", async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user.id;

  const { data: strategiesData, error } = await trycatch(async () => {
    return await db
      .select()
      .from(strategies)
      .where(
        or(
          eq(strategies.userId, userId),
          eq(strategies.visibility, "public"),
          exists(
            db
              .select()
              .from(strategyAccess)
              .where(
                and(
                  eq(strategyAccess.strategyId, strategies.id),
                  eq(strategyAccess.userId, userId),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(strategies.createdAt));
  });

  if (error) {
    console.error("Error fetching strategies:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }

  res.json(strategiesData);
});

// GET one
router.get("/:id", async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user.id;
  const parsed = strategyIdSchema.safeParse({ id: req.params.id });

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid strategy ID" });
    return;
  }

  const strategyId = parsed.data.id;

  const { data: strategy, error } = await trycatch(async () => {
    const result = await db
      .select()
      .from(strategies)
      .where(eq(strategies.id, strategyId))
      .limit(1);
    return result[0];
  });

  if (error) {
    console.error("Error fetching strategy:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }

  if (!strategy) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }

  // Check permissions: owner, public, or shared
  let hasAccess = false;

  if (strategy.visibility === "public") {
    hasAccess = true;
  } else if (strategy.userId === userId) {
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

  if (!hasAccess) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  res.json(strategy);
});

// CREATE
router.post("/", async (req: Request, res: Response) => {
  const validation = createStrategySchema.safeParse(req.body);

  if (!validation.success) {
    res.status(400).json({ error: validation.error.format() });
    return;
  }

  const { name, config } = validation.data;
  const userId = (req as AuthenticatedRequest).user.id;

  const { data: result, error } = await trycatch(async () => {
    return await db
      .insert(strategies)
      .values({
        userId,
        name,
        type: config.type,
        config: config as any,
        visibility: validation.data.visibility,
      })
      .returning();
  });

  if (error) {
    console.error("Error creating strategy:", error);
    return res.status(500).json({ error: "Failed to save strategy" });
  }

  if (result) {
    res.status(201).json(result[0]);
  } else {
    res.status(500).json({ error: "Failed to create strategy" });
  }
});

// UPDATE
router.put("/:id", async (req: Request, res: Response) => {
  const parsed = strategyIdSchema.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid strategy ID" });
    return;
  }

  const validation = updateStrategySchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({ error: validation.error.format() });
    return;
  }

  const strategyId = parsed.data.id;
  const userId = (req as AuthenticatedRequest).user.id;

  const { data: result, error } = await trycatch(async () => {
    // Only the owner can update their strategy
    const updated = await db
      .update(strategies)
      .set({
        ...(validation.data.name && { name: validation.data.name }),
        ...(validation.data.config && {
          type: validation.data.config.type,
          config: validation.data.config as any,
        }),
        ...(validation.data.visibility && {
          visibility: validation.data.visibility,
        }),
      })
      .where(and(eq(strategies.id, strategyId), eq(strategies.userId, userId)))
      .returning();

    return updated;
  });

  if (error) {
    console.error("Error updating strategy:", error);
    return res.status(500).json({ error: "Failed to update strategy" });
  }

  if (!result || result.length === 0) {
    res.status(404).json({ error: "Strategy not found or you do not own it" });
    return;
  }

  res.json(result[0]);
});

// DELETE
router.delete("/:id", async (req: Request, res: Response) => {
  const parsed = strategyIdSchema.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid strategy ID" });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;

  const { error } = await trycatch(async () => {
    const result = await db
      .delete(strategies)
      .where(
        and(eq(strategies.id, parsed.data.id), eq(strategies.userId, userId)),
      )
      .returning();

    return result;
  });

  if (error) {
    console.error("Error deleting strategy:", error);
    return res.status(500).json({ error: "Failed to delete strategy" });
  }

  res.status(204).send();
});

// ──────────────────── Sharing ────────────────────

// GET shares for a strategy (owner only)
router.get("/:id/shares", async (req: Request, res: Response) => {
  const parsed = strategyIdSchema.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid strategy ID" });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  const strategyId = parsed.data.id;

  // Verify ownership
  const { data: strategy, error: fetchError } = await trycatch(async () => {
    const result = await db
      .select()
      .from(strategies)
      .where(and(eq(strategies.id, strategyId), eq(strategies.userId, userId)))
      .limit(1);
    return result[0];
  });

  if (fetchError) {
    console.error("Error fetching strategy:", fetchError);
    return res.status(500).json({ error: "Internal Server Error" });
  }

  if (!strategy) {
    res.status(404).json({ error: "Strategy not found or you do not own it" });
    return;
  }

  // Get all users who have access
  const { data: shares, error: sharesError } = await trycatch(async () => {
    return await db
      .select({
        id: strategyAccess.id,
        userId: strategyAccess.userId,
        userName: users.name,
        userEmail: users.email,
        createdAt: strategyAccess.createdAt,
      })
      .from(strategyAccess)
      .innerJoin(users, eq(strategyAccess.userId, users.id))
      .where(eq(strategyAccess.strategyId, strategyId));
  });

  if (sharesError) {
    console.error("Error fetching shares:", sharesError);
    return res.status(500).json({ error: "Internal Server Error" });
  }

  res.json(shares ?? []);
});

// POST share a strategy with a user by email (owner only)
const shareSchema = z.object({
  email: z.string().email(),
});

router.post("/:id/share", async (req: Request, res: Response) => {
  const parsed = strategyIdSchema.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid strategy ID" });
    return;
  }

  const bodyParsed = shareSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  const strategyId = parsed.data.id;
  const email = bodyParsed.data.email;

  // Verify ownership
  const { data: strategy, error: fetchError } = await trycatch(async () => {
    const result = await db
      .select()
      .from(strategies)
      .where(and(eq(strategies.id, strategyId), eq(strategies.userId, userId)))
      .limit(1);
    return result[0];
  });

  if (fetchError) {
    console.error("Error fetching strategy:", fetchError);
    return res.status(500).json({ error: "Internal Server Error" });
  }

  if (!strategy) {
    res.status(404).json({ error: "Strategy not found or you do not own it" });
    return;
  }

  // Look up target user by email
  const { data: targetUser, error: userError } = await trycatch(async () => {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return result[0];
  });

  if (userError) {
    console.error("Error looking up user:", userError);
    return res.status(500).json({ error: "Internal Server Error" });
  }

  if (!targetUser) {
    res.status(404).json({ error: "No user found with that email" });
    return;
  }

  if (targetUser.id === userId) {
    res.status(400).json({ error: "Cannot share with yourself" });
    return;
  }

  // Check if already shared
  const { data: existing } = await trycatch(async () => {
    const result = await db
      .select()
      .from(strategyAccess)
      .where(
        and(
          eq(strategyAccess.strategyId, strategyId),
          eq(strategyAccess.userId, targetUser.id),
        ),
      )
      .limit(1);
    return result[0];
  });

  if (existing) {
    res.status(409).json({ error: "Already shared with this user" });
    return;
  }

  // Insert access
  const { data: access, error: insertError } = await trycatch(async () => {
    const result = await db
      .insert(strategyAccess)
      .values({
        strategyId,
        userId: targetUser.id,
      })
      .returning();
    return result[0];
  });

  if (insertError) {
    console.error("Error sharing strategy:", insertError);
    return res.status(500).json({ error: "Failed to share strategy" });
  }

  res.status(201).json({
    id: access!.id,
    userId: targetUser.id,
    userName: targetUser.name,
    userEmail: targetUser.email,
    createdAt: access!.createdAt,
  });
});

// DELETE revoke a share (owner only)
router.delete("/:id/share/:userId", async (req: Request, res: Response) => {
  const parsed = strategyIdSchema.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid strategy ID" });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  const strategyId = parsed.data.id;
  const targetUserId = req.params.userId as string;

  // Verify ownership
  const { data: strategy, error: fetchError } = await trycatch(async () => {
    const result = await db
      .select()
      .from(strategies)
      .where(and(eq(strategies.id, strategyId), eq(strategies.userId, userId)))
      .limit(1);
    return result[0];
  });

  if (fetchError) {
    console.error("Error fetching strategy:", fetchError);
    return res.status(500).json({ error: "Internal Server Error" });
  }

  if (!strategy) {
    res.status(404).json({ error: "Strategy not found or you do not own it" });
    return;
  }

  const { error: deleteError } = await trycatch(async () => {
    await db
      .delete(strategyAccess)
      .where(
        and(
          eq(strategyAccess.strategyId, strategyId),
          eq(strategyAccess.userId, targetUserId),
        ),
      );
  });

  if (deleteError) {
    console.error("Error revoking share:", deleteError);
    return res.status(500).json({ error: "Failed to revoke access" });
  }

  res.status(204).send();
});

export default router;
