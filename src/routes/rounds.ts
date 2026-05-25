import { Router, Request, Response } from "express";
import { eq, and, gte, lte, desc, asc, count } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { getRoundsQuerySchema, roundIdSchema } from "../validation/rounds.js";
import { trycatch } from "../utils/try-catch.js";
import { requireAuth } from "../middleware/auth.js";

const roundsRouter = Router();

// Secure all rounds endpoints
roundsRouter.use(requireAuth);

// GET / - List rounds with pagination and filtering
roundsRouter.get("/", async (req: Request, res: Response) => {
  const parsed = getRoundsQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  const { limit, page, startDate, endDate, minBust, maxBust, bustId, sort } =
    parsed.data;
  const offset = (page - 1) * limit;

  const conditions = [];

  if (startDate)
    conditions.push(gte(schema.rounds.createdAt, new Date(startDate)));
  if (endDate) conditions.push(lte(schema.rounds.createdAt, new Date(endDate)));
  if (minBust !== undefined) conditions.push(gte(schema.rounds.bust, minBust));
  if (maxBust !== undefined) conditions.push(lte(schema.rounds.bust, maxBust));
  if (bustId) conditions.push(eq(schema.rounds.bustId, bustId));

  const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const { data: roundsData, error } = await trycatch(async () => {
    // Parallel fetch for data and count for pagination metadata
    const [rounds, [totalCount]] = await Promise.all([
      db
        .select()
        .from(schema.rounds)
        .where(whereCondition)
        .limit(limit)
        .offset(offset)
        .orderBy(
          sort === "asc"
            ? asc(schema.rounds.createdAt)
            : desc(schema.rounds.createdAt),
        ),
      db
        .select({ count: count() })
        .from(schema.rounds) // Correctly counting from the table
        .where(whereCondition),
    ]);

    return {
      data: rounds,
      pagination: {
        total: totalCount?.count || 0,
        page,
        limit,
        totalPages: Math.ceil((totalCount?.count || 0) / limit),
      },
    };
  });

  if (error) {
    console.error("Error fetching rounds:", error);
    return res.status(500).json({ error: "Failed to fetch rounds" });
  }

  res.json(roundsData);
});

// GET /:id - Get a single round by ID
roundsRouter.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = roundIdSchema.safeParse({ id });

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid round ID" });
  }

  const result = await trycatch(async () => {
    return await db
      .select()
      .from(schema.rounds)
      .where(eq(schema.rounds.id, parsed.data.id));
  });

  if (result.error || !result.data) {
    console.error("Error fetching round:", result.error);
    return res.status(500).json({ error: "Failed to fetch round" });
  }

  const round = result.data;

  if (!round.length) {
    return res.status(404).json({ error: "Round not found" });
  }

  res.json(round[0]);
});

export default roundsRouter;
