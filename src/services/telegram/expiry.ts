import { db } from "../../db/index.js";
import { telegramDeliveries, telegramUsers } from "../../db/schema.js";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { bot, invalidateSessionCache } from "./bot.js";
import type { Api } from "grammy";

const apiSignal = () => AbortSignal.timeout(5000) as unknown as NonNullable<Parameters<Api["getChatMember"]>[2]>;

export async function expireSubscriptions(shouldStop = () => false, database: typeof db = db, api: Api | undefined = bot?.api, channel = process.env.PRIVATE_CHANNEL_ID) {
  if (!channel || !api) return;
  const cutoff = new Date();
  let cursor: string | undefined;
  while (!shouldStop()) {
    const batch = await database.select().from(telegramUsers).where(and(
      lt(telegramUsers.expiryTimestamp, cutoff),
      or(isNull(telegramUsers.revokedAt), lt(telegramUsers.revokedAt, telegramUsers.expiryTimestamp)),
      cursor ? gt(telegramUsers.chatId, cursor) : undefined,
    )).orderBy(telegramUsers.chatId).limit(20);
    if (!batch.length) return;
    for (const candidate of batch) {
      cursor = candidate.chatId;
      if (shouldStop()) return;
      try {
        await database.transaction(async tx => {
          const [user] = await tx.select().from(telegramUsers).where(eq(telegramUsers.chatId, candidate.chatId)).for("update");
          if (!user?.expiryTimestamp || user.expiryTimestamp >= new Date() ||
              (user.revokedAt && user.revokedAt >= user.expiryTimestamp)) return;
          let status: string;
          try {
            status = (await api.getChatMember(channel, Number(user.chatId), apiSignal())).status;
          } catch (error) {
            if (!/not found|PARTICIPANT_NOT_FOUND/i.test(String(error))) throw error;
            status = "left";
          }
          if (status === "administrator" || status === "creator") return;
          // Bounded calls keep the shared entitlement row lock valid throughout removal.
          if (status !== "left" && status !== "kicked") await api.banChatMember(channel, Number(user.chatId), {}, apiSignal());
          await api.unbanChatMember(channel, Number(user.chatId), { only_if_banned: true }, apiSignal());
          await tx.update(telegramUsers).set({ revokedAt: new Date() }).where(eq(telegramUsers.chatId, user.chatId));
          await tx.insert(telegramDeliveries).values({ chatId: user.chatId, kind: "expiry_notice",
            dedupeKey: `expired:${user.chatId}:${user.expiryTimestamp.toISOString()}` }).onConflictDoNothing();
          invalidateSessionCache(user.chatId);
        });
      } catch (error) { console.error(`Expiry processing failed for ${candidate.chatId}; will retry:`, error); }
    }
  }
}

export function startExpiryKicker() {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    running = expireSubscriptions(() => stopped).catch(error => console.error("Expiry job failed:", error)).finally(() => {
      if (!stopped) timer = setTimeout(tick, 60 * 60_000);
    });
  };
  timer = setTimeout(tick, 5000);
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
