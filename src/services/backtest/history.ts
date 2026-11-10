import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playerRunBatches, playerRuns } from "../../db/schema.js";
import type { BacktestLedgerEntry, BacktestRound, BacktestSettings } from "./engine.js";
import { packRound, unpackRound, type StoredRound } from "./round-data.js";

type Run = typeof playerRuns.$inferSelect;
type Result = NonNullable<Run["result"]>;
type Batch = Omit<typeof playerRunBatches.$inferInsert, "rounds"> & { rounds?: BacktestRound[] | null };
export type RunSource = Run["source"];
export type HistoryFilter = "all" | "played" | "win" | "loss" | "observed";

const maxCachedRounds = 150_000;
const roundCache = new Map<string, StoredRound[]>();
let cachedRounds = 0;

function remember(key: string, rounds: StoredRound[]) {
  const previous = roundCache.get(key);
  if (previous) cachedRounds -= previous.length;
  roundCache.delete(key);
  roundCache.set(key, rounds);
  cachedRounds += rounds.length;
  while (cachedRounds > maxCachedRounds) {
    const [oldest, values] = roundCache.entries().next().value!;
    roundCache.delete(oldest);
    cachedRounds -= values.length;
  }
}

export async function createSavedRun(userId: string, name: string, source: RunSource, settings: BacktestSettings,
  original?: Pick<Run, "id" | "roundsRunId">, practice?: { startedAt: Date; result: Result }) {
  const id = randomUUID();
  await db.insert(playerRuns).values({
    id, userId, name, source, settings, replayOf: original?.id, roundsRunId: original?.roundsRunId ?? id,
    startedAt: practice?.startedAt, result: practice?.result,
  });
  return id;
}

export async function saveBatches(batches: Batch[]) {
  const stored = batches.map(batch => ({ ...batch, rounds: batch.rounds?.map(packRound) ?? null }));
  await db.insert(playerRunBatches).values(stored);
  for (const batch of stored) if (batch.rounds) remember(`${batch.runId}:${batch.batch}`, batch.rounds);
}

export function finishSavedRun(id: string, result: Result, stopReason = result.summary.stopReason) {
  return db.update(playerRuns).set({ result, stopReason, finishedAt: new Date() }).where(eq(playerRuns.id, id));
}

export function discardSavedRun(id: string) {
  return db.delete(playerRuns).where(eq(playerRuns.id, id));
}

export function interruptSavedRun(id: string, stopReason: string) {
  return db.update(playerRuns).set({ stopReason, finishedAt: new Date() }).where(eq(playerRuns.id, id));
}

export async function savePracticeRound(batch: Batch, result: Result) {
  await db.transaction(async tx => {
    await tx.insert(playerRunBatches).values({ ...batch, rounds: batch.rounds?.map(packRound) ?? null });
    await tx.update(playerRuns).set({ result }).where(eq(playerRuns.id, batch.runId));
  });
}

export async function getSavedRun(userId: string, id: string) {
  const [run] = await db.select().from(playerRuns).where(and(eq(playerRuns.userId, userId), eq(playerRuns.id, id), isNotNull(playerRuns.result)));
  return run;
}

export async function getSavedRunMetadata(userId: string, id: string) {
  const [run] = await db.select({ id: playerRuns.id, roundsRunId: playerRuns.roundsRunId, source: playerRuns.source,
    finishedAt: playerRuns.finishedAt, summary: sql<Result["summary"]>`${playerRuns.result}->'summary'`,
    roundCount: sql<number>`(${playerRuns.result}->'dataset'->>'rounds')::int`,
  }).from(playerRuns).where(and(eq(playerRuns.userId, userId), eq(playerRuns.id, id), isNotNull(playerRuns.result)));
  return run;
}

export async function listSavedRuns(userId: string, page: number, size: number) {
  return db.select({
    id: playerRuns.id, name: playerRuns.name, source: playerRuns.source, replayOf: playerRuns.replayOf,
    startedAt: playerRuns.startedAt, finishedAt: playerRuns.finishedAt, stopReason: playerRuns.stopReason,
    summary: sql<Result["summary"]>`${playerRuns.result}->'summary'`,
    dataset: sql<Result["dataset"]>`${playerRuns.result}->'dataset'`,
  }).from(playerRuns).where(and(eq(playerRuns.userId, userId), isNotNull(playerRuns.result)))
    .orderBy(desc(playerRuns.startedAt), desc(playerRuns.id)).limit(size + 1).offset((page - 1) * size);
}

export async function loadSavedBatches(roundsRunId: string, batch: number, limit: number) {
  const key = `${roundsRunId}:${batch}`;
  const cached = limit === 1 ? roundCache.get(key) : undefined;
  if (cached) {
    remember(key, cached);
    return [{ batch, rounds: cached.map(unpackRound) }];
  }
  const rows = await db.select({ batch: playerRunBatches.batch, rounds: playerRunBatches.rounds }).from(playerRunBatches)
    .where(and(eq(playerRunBatches.runId, roundsRunId), gte(playerRunBatches.batch, batch)))
    .orderBy(asc(playerRunBatches.batch)).limit(limit);
  return rows.map(row => {
    const rounds = row.rounds?.map(unpackRound) ?? [];
    if (limit === 1 && rounds.length) remember(`${roundsRunId}:${row.batch}`, rounds.map(packRound));
    return { batch: row.batch, rounds };
  });
}

export async function listSavedRounds(run: Pick<Run, "id" | "roundsRunId">, roundCount: number, filter: HistoryFilter, offset: number, size: number) {
  const matches = {
    all: sql`true`, played: sql`play <> 'null'::jsonb`, observed: sql`play = 'null'::jsonb`,
    win: sql`play->>'outcome' = 'win'`, loss: sql`play->>'outcome' = 'loss'`,
  }[filter];
  // The two arrays share the same positions. Replays reuse the original round snapshots.
  const result = await db.execute<{ round: StoredRound; play: BacktestLedgerEntry | null; roundIndex: number }>(sql`
    WITH page AS MATERIALIZED (
      SELECT outcomes.batch, position, play FROM ${playerRunBatches} outcomes
      CROSS JOIN LATERAL jsonb_array_elements(outcomes.plays) WITH ORDINALITY AS entries(play, position)
      WHERE outcomes.run_id = ${run.id} AND outcomes.batch < ${roundCount} AND ${matches}
      ORDER BY outcomes.batch, position LIMIT ${size} OFFSET ${offset}
    )
    SELECT inputs.rounds->(page.position::int - 1) AS round, page.play,
      page.batch + page.position::int - 1 AS "roundIndex"
    FROM page JOIN ${playerRunBatches} inputs ON inputs.run_id = ${run.roundsRunId} AND inputs.batch = page.batch
    ORDER BY page.batch, page.position`);
  return result.rows.map(row => {
    const { id, bust, createdAt } = unpackRound(row.round);
    return { ...row, round: { id, bust, createdAt } };
  });
}
