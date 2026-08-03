/**
 * Expiry Kicker — Removes expired premium users from the private channel.
 *
 * Runs immediately on start, then hourly. Processes in batches.
 * Features:
 * - Admin guard: Never attempts to ban admins or channel creators
 * - Rate-limited: All Telegram API calls go through the global rate limiter
 * - Batch processing with configurable size
 */

import { db } from "../../db/index.js";
import { telegramUsers } from "../../db/schema.js";
import { lt } from "drizzle-orm";
import { bot, invalidateSessionCache } from "./bot.js";
import {
  rateLimitedSend,
  rateLimitedBan,
  rateLimitedUnban,
  rateLimitedGetChatMember,
} from "./rate-limiter.js";

const BATCH_SIZE = 20; // Process at most 20 users per cycle to avoid overloading

// Set of admin-level statuses that should never be kicked
const ADMIN_STATUSES = new Set(["creator", "administrator"]);

export function startExpiryKicker() {
  const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;
  if (!PRIVATE_CHANNEL_ID || !bot) return () => undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
          // ─── Admin Guard ────────────────────────────────────────────
          // Check if the user is a channel admin before attempting to kick.
          // This prevents dangerous operations on admin accounts.
          const userId = Number(user.chatId);
          let isAdmin = false;

          try {
            const member = await rateLimitedGetChatMember(
              PRIVATE_CHANNEL_ID,
              userId,
              "low",
            );
            isAdmin = ADMIN_STATUSES.has(member.status);
          } catch (memberErr: unknown) {
            // If we can't check membership, the user may not be in the channel.
            // Treat as safe to skip (not kick blindly).
            const errMsg = memberErr instanceof Error ? memberErr.message : String(memberErr);

            // "user not found" or "member not found" means they're already out
            if (errMsg.includes("not found") || errMsg.includes("PARTICIPANT_NOT_FOUND")) {
              // User already left — just notify them
              await rateLimitedSend(
                user.chatId,
                `⏳ <b>Subscription Expired</b>\n\n` +
                  `Your premium access has ended.\n\n` +
                  `Type /start to renew.`,
                { parse_mode: "HTML" },
                "low",
              ).catch(console.error);
              continue;
            }

            console.warn(
              `⚠️ Could not check admin status for ${user.chatId}:`,
              errMsg,
            );
            continue; // Skip this user and retry next cycle
          }

          if (isAdmin) {
            // Admins keep channel access — skip silently, no nagging messages
            continue;
          }

          // ─── Safe to kick ───────────────────────────────────────────
          await rateLimitedBan(PRIVATE_CHANNEL_ID, userId, "low");
          await rateLimitedUnban(PRIVATE_CHANNEL_ID, userId, "low");

          // Invalidate the session cache so the next message doesn't use stale state
          invalidateSessionCache(user.chatId);

          await rateLimitedSend(
            user.chatId,
            `⏳ <b>Subscription Expired</b>\n\n` +
              `Your premium access has ended. You have been removed from the live channel.\n\n` +
              `Type /start to renew.`,
            { parse_mode: "HTML" },
            "low",
          ).catch(console.error);
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
      if (!stopped) timer = setTimeout(runKicker, 60 * 60 * 1000);
    }
  };

  // Run immediately on first startup, not after 1 hour delay
  timer = setTimeout(runKicker, 5000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
