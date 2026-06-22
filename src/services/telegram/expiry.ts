// expiry.ts
import { db } from "../../db/index.js";
import { telegramUsers } from "../../db/schema.js";
import { lt, and } from "drizzle-orm";
import { bot } from "./bot.js";

// Helper to prevent API throttling
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function startExpiryKicker() {
  const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;
  if (!PRIVATE_CHANNEL_ID || !bot) return;

  const runKicker = async () => {
    try {
      const now = new Date();

      const expiredUsers = await db
        .select()
        .from(telegramUsers)
        .where(
          and(
            lt(telegramUsers.expiryTimestamp, now),
            // eq(telegramUsers.status, "ACTIVE"), // Uncomment when you add status
          ),
        );

      for (const user of expiredUsers) {
        try {
          await bot!.api.banChatMember(PRIVATE_CHANNEL_ID, Number(user.chatId));
          await sleep(200); // 200ms delay between actions to respect API limits

          await bot!.api.unbanChatMember(
            PRIVATE_CHANNEL_ID,
            Number(user.chatId),
          );
          await sleep(200);

          const msg = `⏳ **Subscription Expired**\n\nYour premium access has concluded. You have been removed from the live channel.\n\nType /start to renew your access.`;
          await bot!.api.sendMessage(user.chatId, msg, {
            parse_mode: "Markdown",
          });
          await sleep(500); // Wait half a second before processing the next user
        } catch (err) {
          console.error(`Failed to kick user ${user.chatId}:`, err);
        }
      }
    } catch (err) {
      console.error("Error in Expiry Kicker loop:", err);
    } finally {
      // Safely schedule the next execution only AFTER this one is completely done
      setTimeout(runKicker, 60 * 60 * 1000);
    }
  };

  // Start the first loop
  setTimeout(runKicker, 60 * 60 * 1000);
}
