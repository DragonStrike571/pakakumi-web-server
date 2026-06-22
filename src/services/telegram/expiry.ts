import { db } from "../../db/index.js";
import { telegramUsers } from "../../db/schema.js";
import { lt, and, eq } from "drizzle-orm";
import { bot } from "./bot.js";

export function startExpiryKicker() {
  const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;
  if (!PRIVATE_CHANNEL_ID || !bot) return;

  // Run every 1 Hour
  setInterval(
    async () => {
      try {
        const now = new Date();

        // Find users whose expiry is in the past AND status is still ACTIVE
        const expiredUsers = await db
          .select()
          .from(telegramUsers)
          .where(
            and(
              lt(telegramUsers.expiryTimestamp, now),
              //   eq(telegramUsers.status, "ACTIVE"),
            ),
          );

        for (const user of expiredUsers) {
          try {
            // 1. Ban them to force them out of the channel
            await bot!.api.banChatMember(
              PRIVATE_CHANNEL_ID,
              Number(user.chatId),
            );
            // 2. Immediately unban them so they aren't blacklisted from re-joining later
            await bot!.api.unbanChatMember(
              PRIVATE_CHANNEL_ID,
              Number(user.chatId),
            );

            // 3. DM them the renewal notice
            const msg = `⏳ **Subscription Expired**\n\nYour premium access to the Oracle Engine has concluded. You have been removed from the live channel.\n\nType /start to renew your access.`;
            await bot!.api.sendMessage(user.chatId, msg, {
              parse_mode: "Markdown",
            });
          } catch (err) {
            console.error(`Failed to kick user ${user.chatId}:`, err);
          }
        }
      } catch (err) {
        console.error("Error in Expiry Kicker loop:", err);
      }
    },
    60 * 60 * 1000,
  ); // 1 Hour
}
