import { asc, desc, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { rounds } from "../../db/schema.js";
import type { BacktestRound } from "./engine.js";

type PackedRound = [id: string, bust: number, at: number, since: number | null, reserve: number | null, flags: number];
export type StoredRound = BacktestRound | PackedRound;

// Compact arrays avoid repeating field names. The flags retain absent vs. unknown metrics.
export function packRound(round: BacktestRound): PackedRound {
  const flags = (round.metricsComplete === false ? 1 : round.metricsComplete ? 2 : 0)
    | (round.gapDetected === false ? 4 : round.gapDetected ? 8 : 0)
    | (round.roundsSinceLast3000 !== undefined ? 16 : 0)
    | (round.totalReserveFunds !== undefined ? 32 : 0);
  return [round.id, round.bust, new Date(round.createdAt).getTime(), round.roundsSinceLast3000 ?? null, round.totalReserveFunds ?? null, flags];
}

export function unpackRound(round: StoredRound): BacktestRound {
  if (!Array.isArray(round)) return round;
  const [id, bust, at, since, reserve, flags] = round;
  return { id, bust, createdAt: new Date(at),
    ...(flags & 3 ? { metricsComplete: Boolean(flags & 2) } : {}),
    ...(flags & 12 ? { gapDetected: Boolean(flags & 8) } : {}),
    ...(flags & 16 ? { roundsSinceLast3000: since } : {}),
    ...(flags & 32 ? { totalReserveFunds: reserve } : {}),
  };
}

export async function recordedBoundary(scope: SQL | undefined, offset = 0) {
  const [row] = await db.select({ id: rounds.id, at: sql<string>`${rounds.createdAt}::text` })
    .from(rounds).where(scope).orderBy(desc(rounds.createdAt), desc(rounds.id)).offset(offset).limit(1);
  return row;
}

export async function loadRecordedRounds(scope: SQL | undefined, limit: number) {
  const selected = db.select({
    id: rounds.id, bust: rounds.bust, at: rounds.createdAt, since: rounds.roundsSinceLast3000,
    reserve: rounds.totalReserveFunds, gap: rounds.gapDetected, complete: rounds.metricsComplete,
  }).from(rounds).where(scope).orderBy(asc(rounds.createdAt), asc(rounds.id)).limit(limit).as("selected_rounds");
  const [page] = await db.select({
    packed: sql<PackedRound[] | null>`json_agg(json_build_array(${selected.id}, ${selected.bust},
      extract(epoch from ${selected.at}) * 1000, ${selected.since}, ${selected.reserve},
      48 + CASE WHEN ${selected.complete} THEN 2 ELSE 1 END + CASE WHEN ${selected.gap} THEN 8 ELSE 4 END)
      ORDER BY ${selected.at}, ${selected.id})`,
    lastAt: sql<string | null>`max(${selected.at})::text`,
  }).from(selected);
  // Keep PostgreSQL's timestamp precision in the cursor, including fractions below one millisecond.
  return { rounds: page?.packed?.map(unpackRound) ?? [], lastAt: page?.lastAt ?? null };
}
