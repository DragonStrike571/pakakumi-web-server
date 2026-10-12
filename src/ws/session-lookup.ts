import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";

type Identity = { user: { id: string }; session: { id: string; token: string } } | null;

/** Verify cookies once, then fetch only authorization fields before each send. */
export function createSocketSessionLookup(authenticate: () => Promise<Identity>, database: typeof db = db) {
  let identity: Promise<Identity> | undefined;
  return async () => {
    identity ??= authenticate();
    const verified = await identity;
    if (!verified?.session.id || !verified.session.token || !verified.user.id) return null;
    const [current] = await database.select({ expiresAt: sessions.expiresAt, role: users.role, accessStatus: users.accessStatus })
      .from(sessions).innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, verified.session.id), eq(sessions.token, verified.session.token), eq(users.id, verified.user.id))).limit(1);
    return current ? { session: { expiresAt: current.expiresAt }, user: { role: current.role, accessStatus: current.accessStatus } } : null;
  };
}
