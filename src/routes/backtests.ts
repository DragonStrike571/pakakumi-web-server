import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, exists, gte, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { rounds, strategies, strategyAccess } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAccess } from "../middleware/access.js";
import type { AuthenticatedRequest } from "../types/express.js";
import { runBacktest } from "../services/backtest/engine.js";
import { runBacktestSchema } from "../validation/backtests.js";
import type { StrategyConfig } from "../utils/strategies/core.js";
import { strategyConfigSchema } from "../validation/strategies.js";

const router = Router();
router.use(requireAuth, requireActiveAccess());
router.use(rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
}));

router.post("/run", async (req: Request, res: Response) => {
  const parsed = runBacktestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  let strategy: StrategyConfig;

  if (parsed.data.strategy) {
    strategy = parsed.data.strategy;
  } else {
    const [record] = await db
      .select({ config: strategies.config })
      .from(strategies)
      .where(and(
        eq(strategies.id, parsed.data.strategyId!),
        or(
          eq(strategies.userId, userId),
          eq(strategies.visibility, "public"),
          exists(
            db.select({ id: strategyAccess.id })
              .from(strategyAccess)
              .where(and(
                eq(strategyAccess.strategyId, strategies.id),
                eq(strategyAccess.userId, userId),
              )),
          ),
        ),
      ))
      .limit(1);

    if (!record) {
      res.status(404).json({ error: "Strategy not found or access denied" });
      return;
    }
    const storedStrategy = strategyConfigSchema.safeParse(record.config);
    if (!storedStrategy.success) {
      res.status(422).json({ error: "The saved strategy configuration is invalid" });
      return;
    }
    strategy = storedStrategy.data;
  }

  const conditions = [];
  if (parsed.data.range.startDate) {
    conditions.push(gte(rounds.createdAt, new Date(parsed.data.range.startDate)));
  }
  if (parsed.data.range.endDate) {
    conditions.push(lte(rounds.createdAt, new Date(parsed.data.range.endDate)));
  }

  try {
    const history = (await db
      .select({
        id: rounds.id,
        bust: rounds.bust,
        createdAt: rounds.createdAt,
        roundsSinceLast3000: rounds.roundsSinceLast3000,
        totalReserveFunds: rounds.totalReserveFunds,
        gapDetected: rounds.gapDetected,
        metricsComplete: rounds.metricsComplete,
      })
      .from(rounds)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(rounds.createdAt))
      .limit(parsed.data.range.limit))
      .reverse();

    if (history.length === 0) {
      res.status(422).json({ error: "No historical rounds match this date range" });
      return;
    }

    const result = runBacktest({
      rounds: history,
      strategy,
      initialCapital: parsed.data.initialCapital,
      scenario: parsed.data.scenario,
      includeLedger: parsed.data.includeLedger,
    });

    if (history.length === parsed.data.range.limit) {
      result.warnings.push(
        `History reached the ${parsed.data.range.limit.toLocaleString()} round limit; narrow the date range to verify the complete interval`,
      );
    }

    res.json({
      ...result,
      dataset: {
        rounds: history.length,
        firstRoundAt: history[0]!.createdAt,
        lastRoundAt: history.at(-1)!.createdAt,
      },
    });
  } catch (error) {
    console.error("Backtest failed:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Backtest failed",
    });
  }
});

export default router;
