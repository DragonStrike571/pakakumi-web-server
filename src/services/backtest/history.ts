import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playerRunBatches, playerRuns } from "../../db/schema.js";
import type { BacktestLedgerEntry, BacktestRound, BacktestSettings } from "./engine.js";

type Run = typeof playerRuns.$inferSelect;
type Result = NonNullable<Run["result"]>;
type Batch = typeof playerRunBatches.$inferInsert;
export type RunSource = Run["source"];
export type HistoryFilter = "all" | "played" | "win" | "loss" | "observed";

export async function createSavedRun(userId: string, name: string, source: RunSource, settings: BacktestSettings,
  original?: Pick<Run, "id" | "roundsRunId">, practice?: { startedAt: Date; result: Result }) {
  const id = randomUUID();
  await db.insert(playerRuns).values({
    id, userId, name, source, settings, replayOf: original?.id, roundsRunId: original?.roundsRunId ?? id,
    startedAt: practice?.startedAt, result: practice?.result,
  });
  return id;
}

export function saveBatches(batches: Batch[]) {
  return db.insert(playerRunBatches).values(batches);
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
    await tx.insert(playerRunBatches).values(batch);
    await tx.update(playerRuns).set({ result }).where(eq(playerRuns.id, batch.runId));
  });
}

export async function getSavedRun(userId: string, id: string) {
  const [run] = await db.select().from(playerRuns).where(and(eq(playerRuns.userId, userId), eq(playerRuns.id, id), isNotNull(playerRuns.result)));
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

export function loadSavedBatches(roundsRunId: string, batch: number, limit: number) {
  return db.select({ batch: playerRunBatches.batch, rounds: playerRunBatches.rounds }).from(playerRunBatches)
    .where(and(eq(playerRunBatches.runId, roundsRunId), gte(playerRunBatches.batch, batch)))
    .orderBy(asc(playerRunBatches.batch)).limit(limit);
}

export async function listSavedRounds(run: Run, filter: HistoryFilter, offset: number, size: number) {
  const matches = {
    all: sql`true`, played: sql`play <> 'null'::jsonb`, observed: sql`play = 'null'::jsonb`,
    win: sql`play->>'outcome' = 'win'`, loss: sql`play->>'outcome' = 'loss'`,
  }[filter];
  // The two arrays share the same positions. Replays reuse the original round snapshots.
  const result = await db.execute<{ round: BacktestRound; play: BacktestLedgerEntry | null; roundIndex: number }>(sql`
    SELECT inputs.rounds->(position::int - 1) AS round, play,
      inputs.batch + position::int - 1 AS "roundIndex"
    FROM ${playerRunBatches} outcomes
    JOIN ${playerRunBatches} inputs ON inputs.run_id = ${run.roundsRunId} AND inputs.batch = outcomes.batch
    CROSS JOIN LATERAL jsonb_array_elements(outcomes.plays) WITH ORDINALITY AS entries(play, position)
    WHERE outcomes.run_id = ${run.id} AND outcomes.batch < ${run.result!.dataset.rounds} AND ${matches}
    ORDER BY outcomes.batch, position
    LIMIT ${size} OFFSET ${offset}`);
  return result.rows;
}
