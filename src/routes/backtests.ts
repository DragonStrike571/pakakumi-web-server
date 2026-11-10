import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, exists, gte, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { rounds, strategies, strategyAccess } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireActiveAccess } from "../middleware/access.js";
import type { AuthenticatedRequest } from "../types/express.js";
import { hostedPractice } from "../services/backtest/practice.js";
import { createSavedRun, discardSavedRun, finishSavedRun, getSavedRun, getSavedRunMetadata, listSavedRounds, listSavedRuns, loadSavedBatches, saveBatches } from "../services/backtest/history.js";
import { loadRecordedRounds, recordedBoundary } from "../services/backtest/round-data.js";
import type { BacktestRound } from "../services/backtest/engine.js";
import { backtestRunner } from "../services/backtest/runner.js";
import { runBacktestSchema } from "../validation/backtests.js";
import { strategyConfigSchema } from "../validation/strategies.js";
import { toRunSettings, usesLocalPlayerEngine } from "../utils/local-player/strategy/config.js";
import { z } from "zod";

const router = Router();
router.use(requireAuth, requireActiveAccess());
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
const runLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const sampleRounds = [1.2, 2.4, 1.01, 5.2, 100, 1.5, 3, 120, 2, 100, 1.2, 1.8, 4.5, 2.2, 1, 7];

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

  const { initialCapital, scenario, includeLedger, onBlocked } = parsed.data;
  return { data: parsed.data, userId, name, settings: { strategy, initialCapital, scenario, includeLedger, onBlocked } };
}

router.get("/practice", (req, res) => {
  res.json({ session: hostedPractice.get((req as AuthenticatedRequest).user.id) });
});

router.post("/practice", runLimiter, async (req, res) => {
  const run = await prepareRun(req, res);
  if (!run) return;
  if (run.data.replayOf) {
    res.status(400).json({ error: "Use a replay to run on saved rounds." });
    return;
  }
  try {
    res.status(201).json({ session: await hostedPractice.start(run.userId, run.name, { ...run.settings, ledgerLimit: 500 }) });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  }
});

router.post("/practice/stop", async (req, res) => {
  res.json({ session: await hostedPractice.stop((req as AuthenticatedRequest).user.id) });
});

const pageSchema = z.coerce.number().int().min(1).max(1_000_000).default(1);
router.get("/runs", async (req, res) => {
  const page = pageSchema.safeParse(req.query.page);
  if (!page.success) { res.status(400).json({ error: "Invalid page" }); return; }
  const size = 20;
  const userId = (req as AuthenticatedRequest).user.id;
  const runs = await listSavedRuns(userId, page.data, size);
  res.json({ runs: runs.slice(0, size).map(run => ({ ...run, running: hostedPractice.isRunning(userId, run.id) })), hasMore: runs.length > size });
});

router.get("/runs/:id", async (req: Request, res) => {
  const id = z.uuid().safeParse(req.params.id);
  const userId = (req as AuthenticatedRequest).user.id;
  const run = id.success && await getSavedRun(userId, id.data);
  if (!run) { res.status(404).json({ error: "Saved run not found" }); return; }
  const { userId: _user, roundsRunId: _rounds, ...details } = run;
  res.json({ ...details, running: hostedPractice.isRunning(userId, run.id) });
});

router.get("/runs/:id/rounds", async (req: Request, res) => {
  const id = z.uuid().safeParse(req.params.id);
  const page = pageSchema.safeParse(req.query.page);
  const filter = z.enum(["all", "played", "win", "loss", "observed"]).default("all").safeParse(req.query.filter);
  if (!page.success || !filter.success) { res.status(400).json({ error: "Invalid page or result filter" }); return; }
  const run = id.success ? await getSavedRunMetadata((req as AuthenticatedRequest).user.id, id.data) : undefined;
  if (!run) { res.status(404).json({ error: "Saved run not found" }); return; }
  const size = 50;
  const { summary, roundCount } = run;
  const total = { all: roundCount, played: summary.totalBets, win: summary.wins,
    loss: summary.losses, observed: roundCount - summary.totalBets }[filter.data];
  const offset = (page.data - 1) * size;
  res.json({ total, size, rows: offset < total ? await listSavedRounds(run, roundCount, filter.data, offset, size) : [] });
});

router.post("/run", runLimiter, async (req: Request, res: Response) => {
  const run = await prepareRun(req, res);
  if (!run) return;
  const { data, settings } = run;
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", cancel);
  let runId: string | undefined;

  try {
    let original = data.replayOf ? await getSavedRunMetadata(run.userId, data.replayOf) : undefined;
    if (data.replayOf && !original) { res.status(404).json({ error: "Saved run not found" }); return; }
    if (original && hostedPractice.isRunning(run.userId, original.id)) {
      res.status(409).json({ error: "Stop practice and record at least one round before replaying it." });
      return;
    }
    if (original && !original.finishedAt) original = await getSavedRunMetadata(run.userId, original.id);
    if (data.replayOf && !original?.roundCount) {
      res.status(409).json({ error: "This saved run has no rounds to replay." });
      return;
    }
    let replayBatches: Awaited<ReturnType<typeof loadSavedBatches>> = [];
    const archive = async (load: () => Promise<BacktestRound[]>, truncated = false) => {
      const id = await createSavedRun(run.userId, run.name, original?.source ?? data.source, settings, original);
      runId = id;
      let batch = 0;
      const result = await backtestRunner.runHistory({ ...settings, ledgerLimit: 200 }, load, controller.signal, async (history, plays) => {
        if (original) {
          await saveBatches(replayBatches.map(saved => ({ runId: id, batch: saved.batch,
            plays: plays.slice(saved.batch - batch, saved.batch - batch + saved.rounds!.length) })));
        } else await saveBatches([{ runId: id, batch, rounds: history, plays }]);
        batch += history.length;
      });
      if (original && result.dataset?.rounds !== original.roundCount) throw new Error("The saved round snapshot is incomplete.");
      if (truncated) result.warnings.push(`This test used the newest ${data.range.limit.toLocaleString()} matching rounds. Choose all matching rounds for the full range.`);
      const { ledger, dataset, ...summary } = result;
      await finishSavedRun(id, { ...summary, dataset: dataset! });
      res.json({ ...summary, ledger, dataset, runId: id });
    };
    if (original) {
      let position = 0;
      const { roundCount, roundsRunId, source } = original;
      await archive(async () => {
        if (position >= roundCount) return [];
        replayBatches = await loadSavedBatches(roundsRunId, position, source === "practice" ? 200 : 1);
        const saved = replayBatches.flatMap(({ rounds }) => rounds ?? []);
        position += saved.length;
        return saved;
      });
      return;
    }
    if (data.source === "examples") {
      const examples = data.exampleRounds ?? sampleRounds;
      const start = Date.now();
      const history = examples.map((bust, index) => ({
        id: `example-${index + 1}`, bust, createdAt: new Date(start + index * 1000),
      }));
      await archive(async () => history.splice(0, 10_000));
      return;
    }

    const conditions = [];
    if (data.range.startDate) conditions.push(gte(rounds.createdAt, new Date(data.range.startDate)));
    if (data.range.endDate) conditions.push(lte(rounds.createdAt, new Date(data.range.endDate)));
    const scope = and(...conditions);

    // Freeze the selection and page from the oldest round inside it.
    const last = await recordedBoundary(scope);
    if (!last) {
      res.status(422).json({ error: "No historical rounds match this date range" });
      return;
    }
    const end = sql`(${rounds.createdAt}, ${rounds.id}) <= (${last.at}::timestamp, ${last.id}::uuid)`;
    const endScope = and(scope, sql`${rounds.createdAt} <= ${last.at}::timestamp`, end);
    const excluded = data.range.all ? undefined : await recordedBoundary(endScope, data.range.limit);
    let cursor = excluded;
    let remaining = data.range.all ? Infinity : data.range.limit;
    await archive(async () => {
      if (!remaining) return [];
      const after = cursor && sql`(${rounds.createdAt}, ${rounds.id}) > (${cursor.at}::timestamp, ${cursor.id}::uuid)`;
      const size = Math.min(10_000, remaining);
      const page = await loadRecordedRounds(and(endScope, cursor && sql`${rounds.createdAt} >= ${cursor.at}::timestamp`, after), size);
      remaining = page.rounds.length < size ? 0 : remaining - page.rounds.length;
      if (page.lastAt) cursor = { at: page.lastAt, id: page.rounds.at(-1)!.id };
      return page.rounds;
    }, Boolean(excluded));
  } catch (error) {
    if (runId) await discardSavedRun(runId).catch(cleanup => console.error("Could not discard incomplete run:", cleanup));
    if (controller.signal.aborted) return;
    console.error("Backtest failed:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Backtest failed" });
  } finally {
    res.removeListener("close", cancel);
  }
});

export default router;
