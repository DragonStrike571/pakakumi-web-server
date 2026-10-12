/**
 * Message Handlers — Processes non-command text messages.
 *
 * Handles:
 * 1. Admin replies to support tickets
 * 2. Close support override
 * 3. Support ticket creation
 *
 * All proactive messages (admin reply delivery, ticket forwarding) use the
 * global rate limiter. Direct ctx.reply() calls are fine for inline responses.
 */

import { Bot, InlineKeyboard } from "grammy";
import { type MyContext, setSessionState } from "../bot.js";
import { escapeHtml, truncateHtml } from "../../../utils/html.js";
import { db } from "../../../db/index.js";
import { telegramUsers, supportTickets } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { buildMainMenuKeyboard } from "./commands.js";
import { rateLimitedSend } from "../rate-limiter.js";

const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;

// Maximum message length for Telegram API
const MAX_TELEGRAM_MSG_LENGTH = 4096;

/**
 * Truncate a message to Telegram's max length, preserving HTML tags.
 */
function truncateMessage(text: string, maxLen: number = MAX_TELEGRAM_MSG_LENGTH): string {
  return truncateHtml(text, maxLen);
}

export function setupMessages(bot: Bot<MyContext>, send = rateLimitedSend) {
  // Listen for both direct messages/groups AND channel posts
  bot.on(["message:text", "channel_post:text"], async (ctx) => {
    const text = ctx.message?.text || ctx.channelPost?.text;
    const replyToText =
      ctx.message?.reply_to_message?.text ||
      ctx.channelPost?.reply_to_message?.text;

    if (!text) return;

    // In channel posts, ctx.from might be undefined. Fall back to chat ID.
    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString() || chatId;

    // Null safety: if we can't determine a chat ID, bail out
    if (!chatId) return;

    if (text.startsWith("/")) return;

    // 1. ADMIN REPLY LOGIC
    if (chatId === ADMIN_CHANNEL_ID || userId === ADMIN_CHANNEL_ID) {
      if (replyToText) {
        const match = replyToText.match(/User ID:\s*(-?\d+)/i);

        if (match && match[1]) {
          const targetUserId = match[1];
          try {
            await send(
              targetUserId,
              truncateMessage(`📩 <b>Support Reply:</b>\n\n${escapeHtml(text)}`),
              { parse_mode: "HTML" },
              "high",
            );
            await ctx.reply("✅ Reply delivered to user.");
          } catch (err) {
            console.error(`Error sending reply to user ${targetUserId}:`, err);
            await ctx.reply(
              "❌ Could not send reply. The user may have blocked the bot.",
            );
          }
        } else {
          await ctx.reply(
            "⚠️ Could not find User ID in the message you replied to.",
          );
        }
      }
      return;
    }

    // 2. CLOSE SUPPORT OVERRIDE
    if (text === "❌ Close Support") {
      await setSessionState(ctx, "command");

      const botUsername = ctx.me?.username || "pk_oracle_bot";
      const menuKb = buildMainMenuKeyboard(botUsername);

      await ctx.reply("✅ Support closed. You are back in the main menu.", {
        reply_markup: { remove_keyboard: true },
      });
      // Send the inline menu separately so it renders cleanly
      await ctx.reply("📊 <b>Pakakumi Oracle</b>\n\nChoose an option:", {
        parse_mode: "HTML",
        reply_markup: menuKb,
      });
      return;
    }

    // 3. SUPPORT TICKET CREATION
    if (ctx.dbState === "support") {
      const username = ctx.from?.username || ctx.from?.first_name || "Unknown";

      // Sanitize input: cap message length
      const sanitizedMessage = text.substring(0, 1000);

      const [ticket] = await db
        .insert(supportTickets)
        .values({ chatId, message: sanitizedMessage })
        .returning();

      if (ADMIN_CHANNEL_ID) {
        const ticketMsg = truncateMessage(
          `🎫 <b>Support Ticket (#${ticket.id})</b>\n[User ID: ${chatId}]\nUsername: @${escapeHtml(username)}\n\nMessage:\n${escapeHtml(sanitizedMessage)}\n\n<i>Reply to this message to answer the user.</i>`,
        );
        try { await send(
          ADMIN_CHANNEL_ID,
          ticketMsg,
          { parse_mode: "HTML" },
          "normal",
        ); } catch (error) {
          console.error(`Support ticket ${ticket.id} delivery failed:`, error);
          await ctx.reply("Your message was saved, but delivery to support failed. Please try again later.");
          return;
        }
      } else {
        await ctx.reply("Your message was saved. Support delivery is currently unavailable; please try again later.");
        return;
      }

      await ctx.reply(
        "✅ Message sent. An admin will reply here shortly.\n\nType another message or click '❌ Close Support'.",
      );
      return;
    }
  });
}
