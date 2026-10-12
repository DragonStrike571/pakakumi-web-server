import { sql, type SQL } from "drizzle-orm";

type Target = { target: number; createdAt: string };

/** Send only changed entries; the durable daily counters still commit with every round. */
export function dailyTargetPatch<T extends Target>(column: SQL, previous: T[], next: T[]): SQL {
  if (!next.length) return sql`'[]'::jsonb`;
  const sameEntry = (a: T, b: T) => a.target === b.target && a.createdAt === b.createdAt;
  const first = previous.findIndex(entry => sameEntry(entry, next[0]!));
  const offset = first < 0 ? previous.length : first;
  const retained = previous.slice(offset);
  // A replacement/reordering is uncommon, but must never produce an incorrect patch.
  if (retained.length > next.length || retained.some((entry, index) => !sameEntry(entry, next[index]!))) {
    return sql`${JSON.stringify(next)}::jsonb`;
  }
  let expression = offset === previous.length ? sql`'[]'::jsonb`
    : offset > 0 ? sql`jsonb_path_query_array(${column}, ${`$[${offset} to last]`}::jsonpath)` : column;
  retained.forEach((entry, index) => {
    if (JSON.stringify(entry) !== JSON.stringify(next[index])) {
      expression = sql`jsonb_set(${expression}, ${`{${index}}`}::text[], ${JSON.stringify(next[index])}::jsonb, false)`;
    }
  });
  const appended = next.slice(retained.length);
  return appended.length ? sql`${expression} || ${JSON.stringify(appended)}::jsonb` : expression;
}
