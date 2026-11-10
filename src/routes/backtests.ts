import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { and, asc, desc, eq, exists, gte, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { rounds, strategies, strategyAccess } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAccess } from "../middleware/access.js";
import type { AuthenticatedRequest } from "../types/express.js";
import { hostedPractice } from "../services/backtest/practice.js";
import { backtestRunner } from "../services/backtest/runner.js";
import { runBacktestSchema } from "../validation/backtests.js";
import { strategyConfigSchema } from "../validation/strategies.js";
import { toRunSettings, usesLocalPlayerEngine } from "../utils/local-player/strategy/config.js";
import type { z } from "zod";

const router = Router();
router.use(requireAuth, requireActiveAccess());
const runLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const sampleRounds = [1.2, 2.4, 1.01, 5.2, 100, 1.5, 3, 120, 2, 100, 1.2, 1.8, 4.5, 2.2, 1, 7];
const roundFields = {
  id: rounds.id,
  bust: rounds.bust,
  createdAt: rounds.createdAt,
  roundsSinceLast3000: rounds.roundsSinceLast3000,
  totalReserveFunds: rounds.totalReserveFunds,
  gapDetected: rounds.gapDetected,
  metricsComplete: rounds.metricsComplete,
};

async function prepareRun(req: Request, res: Response) {
  const parsed = runBacktestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  let strategy: z.output<typeof strategyConfigSchema>;
  let name = "Test setup";

  if (parsed.data.strategy) {
    strategy = parsed.data.strategy;
    name = parsed.data.name ?? name;
  } else {
    const [record] = await db
      .select({ config: strategies.config, name: strategies.name })
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
    name = record.name;
  }

  if (usesLocalPlayerEngine(strategy)) {
    try {
      const rules = parsed.data.scenario?.rules;
      const config = rules ? { ...strategy, execution: { ...strategy.execution, rules } } : strategy;
      toRunSettings({ strategy: config, initialCapital: parsed.data.initialCapital, maxBet: 5000, mode: "practice" });
    } catch (error) {
      res.status(422).json({ error: (error as Error).message });
      return;
    }
  }

  const { initialCapital, scenario, includeLedger } = parsed.data;
  return { data: parsed.data, userId, name, settings: { strategy, initialCapital, scenario, includeLedger } };
}

router.get("/practice", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ session: hostedPractice.get((req as AuthenticatedRequest).user.id) });
});

router.post("/practice", runLimiter, async (req, res) => {
  const run = await prepareRun(req, res);
  if (!run) return;
  try {
    res.status(201).json({ session: hostedPractice.start(run.userId, run.name, { ...run.settings, ledgerLimit: 500 }) });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  }
});

router.post("/practice/stop", (req, res) => {
  res.json({ session: hostedPractice.stop((req as AuthenticatedRequest).user.id) });
});

router.post("/run", runLimiter, async (req: Request, res: Response) => {
  const run = await prepareRun(req, res);
  if (!run) return;
  const { data, settings } = run;
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", cancel);

  try {
    if (data.source === "examples") {
      const examples = data.exampleRounds ?? sampleRounds;
      const start = Date.now();
      const history = examples.map((bust, index) => ({
        id: `example-${index + 1}`, bust, createdAt: new Date(start + index * 1000),
      }));
      const result = await backtestRunner.run({ ...settings, rounds: history }, controller.signal);
      res.json({ ...result, dataset: { rounds: history.length, firstRoundAt: history[0]!.createdAt, lastRoundAt: history.at(-1)!.createdAt } });
      return;
    }

    const conditions = [];
    if (data.range.startDate) conditions.push(gte(rounds.createdAt, new Date(data.range.startDate)));
    if (data.range.endDate) conditions.push(lte(rounds.createdAt, new Date(data.range.endDate)));
    const scope = and(...conditions);

    if (data.range.all) {
      // Freeze the end of this replay while the collector keeps appending new rounds.
      const [last] = await db.select({ id: rounds.id, createdAt: rounds.createdAt })
        .from(rounds).where(scope).orderBy(desc(rounds.createdAt), desc(rounds.id)).limit(1);
      if (!last) {
        res.status(422).json({ error: "No historical rounds match this date range" });
        return;
      }
      const end = sql`(${rounds.createdAt}, ${rounds.id}) <= (${sql.param(last.createdAt, rounds.createdAt)}, ${last.id}::uuid)`;
      let cursor: typeof last | undefined;
      let exhausted = false;
      const result = await backtestRunner.runHistory(settings, async () => {
        if (exhausted) return [];
        const after = cursor && sql`(${rounds.createdAt}, ${rounds.id}) > (${sql.param(cursor.createdAt, rounds.createdAt)}, ${cursor.id}::uuid)`;
        const batch = await db.select(roundFields).from(rounds)
          .where(and(scope, lte(rounds.createdAt, last.createdAt), end,
            cursor && gte(rounds.createdAt, cursor.createdAt), after))
          .orderBy(asc(rounds.createdAt), asc(rounds.id)).limit(10_000);
        cursor = batch.at(-1);
        exhausted = batch.length < 10_000;
        return batch;
      }, controller.signal);
      res.json(result);
      return;
    }

    const history = (await db.select(roundFields).from(rounds).where(scope)
      .orderBy(desc(rounds.createdAt), desc(rounds.id)).limit(data.range.limit + 1));
    if (history.length === 0) {
      res.status(422).json({ error: "No historical rounds match this date range" });
      return;
    }
    const truncated = history.length > data.range.limit;
    if (truncated) history.pop();
    history.reverse();
    const result = await backtestRunner.run({ ...settings, rounds: history }, controller.signal);
    if (truncated) result.warnings.push(`This test used the newest ${data.range.limit.toLocaleString()} matching rounds. Choose all matching rounds for the full range.`);
    res.json({
      ...result,
      dataset: { rounds: history.length, firstRoundAt: history[0]!.createdAt, lastRoundAt: history.at(-1)!.createdAt },
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error("Backtest failed:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Backtest failed" });
  } finally {
    res.removeListener("close", cancel);
  }
});

export default router;
