import { and, eq, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { telegramDeliveries, telegramUsers } from "../../db/schema.js";
import { bot } from "./bot.js";
import { rateLimitedCreateInviteLink, rateLimitedSend, rateLimitedUnban } from "./rate-limiter.js";
import { escapeHtml } from "../../utils/html.js";

export async function requestPremiumInvite(chatId: string, database: typeof db = db) {
  const user = await database.query.telegramUsers.findFirst({ where: eq(telegramUsers.chatId, chatId) });
  if (!user?.expiryTimestamp || user.expiryTimestamp <= new Date()) return false;
  await database.insert(telegramDeliveries).values({ chatId, kind: "invite", dedupeKey: `rejoin:${chatId}:${Math.floor(Date.now() / 60_000)}` }).onConflictDoNothing();
  return true;
}

type Transport = { createInvite: typeof rateLimitedCreateInviteLink; send: typeof rateLimitedSend; unban: typeof rateLimitedUnban };
export async function dispatchDeliveries(database: typeof db = db, transport?: Transport, channel = process.env.PRIVATE_CHANNEL_ID, shouldStop = () => false) {
  if (!channel || (!transport && !bot)) return;
  transport ??= { createInvite: rateLimitedCreateInviteLink, send: rateLimitedSend, unban: rateLimitedUnban };
  for (let i = 0; i < 20 && !shouldStop(); i++) {
    const job = await database.transaction(async tx => {
      const [row] = await tx.select().from(telegramDeliveries).where(or(
        and(eq(telegramDeliveries.status, "pending"), lte(telegramDeliveries.nextAttemptAt, new Date())),
        and(eq(telegramDeliveries.status, "sending"), lte(telegramDeliveries.lockedAt, new Date(Date.now() - 10 * 60_000))),
      )).orderBy(telegramDeliveries.nextAttemptAt).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      const [claimed] = await tx.update(telegramDeliveries).set({ status: "sending", lockedAt: new Date(), attempts: sql`${telegramDeliveries.attempts} + 1` })
        .where(eq(telegramDeliveries.id, row.id)).returning();
      return claimed;
    });
    if (!job) return;
    try {
      const user = await database.query.telegramUsers.findFirst({ where: eq(telegramUsers.chatId, job.chatId) });
      const active = Boolean(user?.expiryTimestamp && user.expiryTimestamp > new Date());
      if (job.kind === "invite" && active) {
        // Also repairs a removal interrupted after ban but before unban/commit.
        await transport.unban(channel, Number(job.chatId), "high");
        const invite = await transport.createInvite(channel, {
          member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        }, "high");
        await transport.send(job.chatId, `🎉 <b>Premium Access Active</b>\n\nAccess until <b>${user!.expiryTimestamp!.toDateString()}</b>.\n\nJoin the Premium Room (one use, valid 24 hours):\n${escapeHtml(invite.invite_link)}`, { parse_mode: "HTML" }, "high");
      } else if (job.kind === "expiry_notice" && !active) {
        await transport.send(job.chatId, "⏳ <b>Subscription Expired</b>\n\nYour premium access has ended. Type /start to renew.", { parse_mode: "HTML" }, "low");
      }
      await database.update(telegramDeliveries).set({ status: "sent", lockedAt: null, lastError: null }).where(eq(telegramDeliveries.id, job.id));
    } catch (error) {
      await database.update(telegramDeliveries).set({ status: "pending", lockedAt: null,
        nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(job.attempts, 7))),
        lastError: String(error).slice(0, 500),
      }).where(eq(telegramDeliveries.id, job.id));
      console.error(`Telegram delivery ${job.id} retained for retry:`, error);
    }
  }
}

export function startDeliveryWorker() {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    running = dispatchDeliveries(db, undefined, undefined, () => stopped).catch(error => console.error("Telegram outbox failed:", error)).finally(() => {
      if (!stopped) timer = setTimeout(tick, 10_000);
    });
  };
  timer = setTimeout(tick, 1000);
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
