// expiry.ts — Runs immediately on start, then hourly. Processes in batches.
import { db } from "../../db/index.js";
import { telegramUsers } from "../../db/schema.js";
import { lt } from "drizzle-orm";
import { bot } from "./bot.js";

// Helper to prevent API throttling
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BATCH_SIZE = 20; // Process at most 20 users per cycle to avoid Telegram rate limits

export function startExpiryKicker() {
  const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;
  if (!PRIVATE_CHANNEL_ID || !bot) return;

  const runKicker = async () => {
    try {
      const now = new Date();

      const expiredUsers = await db
        .select()
        .from(telegramUsers)
        .where(lt(telegramUsers.expiryTimestamp, now))
        .limit(BATCH_SIZE);

      for (const user of expiredUsers) {
        try {
          await bot!.api.banChatMember(PRIVATE_CHANNEL_ID, Number(user.chatId));
          await sleep(200);

          await bot!.api.unbanChatMember(
            PRIVATE_CHANNEL_ID,
            Number(user.chatId),
          );
          await sleep(200);

          const msg =
            `⏳ <b>Subscription Expired</b>\n\n` +
            `Your premium access has ended. You have been removed from the live channel.\n\n` +
            `Type /start to renew.`;
          await bot!.api.sendMessage(user.chatId, msg, {
            parse_mode: "HTML",
          });
          await sleep(500);
        } catch (err) {
          console.error(`Failed to kick user ${user.chatId}:`, err);
        }
      }

      if (expiredUsers.length > 0) {
        console.log(`🔄 Expiry kicker processed ${expiredUsers.length} users.`);
      }
    } catch (err) {
      console.error("Error in Expiry Kicker loop:", err);
    } finally {
      // Schedule the next execution only AFTER this one is completely done
      setTimeout(runKicker, 60 * 60 * 1000);
    }
  };

  // Run immediately on first startup, not after 1 hour delay
  setTimeout(runKicker, 5000);
}
