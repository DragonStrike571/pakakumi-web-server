// messages.ts
import { Bot, InlineKeyboard } from "grammy";
import { MyContext } from "../bot.js";
import { db } from "../../../db/index.js";
import { telegramUsers, supportTickets } from "../../../db/schema.js";
import { eq } from "drizzle-orm";

const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;

export function setupMessages(bot: Bot<MyContext>) {
  // Listen for both direct messages/groups AND channel posts
  bot.on(["message:text", "channel_post:text"], async (ctx) => {
    const text = ctx.message?.text || ctx.channelPost?.text;
    const replyToText =
      ctx.message?.reply_to_message?.text ||
      ctx.channelPost?.reply_to_message?.text;

    if (!text) return;

    // In channel posts, ctx.from might be undefined. Fall back to chat ID.
    const chatId = ctx.chat?.id.toString();
    const userId = ctx.from?.id.toString() || chatId;

    if (text.startsWith("/")) return;

    // 1. ADMIN REPLY LOGIC
    if (chatId === ADMIN_CHANNEL_ID || userId === ADMIN_CHANNEL_ID) {
      if (replyToText) {
        const match = replyToText.match(/User ID:\s*(-?\d+)/i);

        if (match && match[1]) {
          const targetUserId = match[1];
          try {
            await bot.api.sendMessage(
              targetUserId,
              `📩 **Support Reply:**\n\n${text}`,
              { parse_mode: "Markdown" },
            );
            await ctx.reply("✅ Reply successfully delivered to user.");
          } catch (err) {
            console.error(`Error sending reply to user ${targetUserId}:`, err);
            await ctx.reply(
              "❌ Failed to send reply. The user may have blocked the bot.",
            );
          }
        } else {
          await ctx.reply(
            "⚠️ Could not extract User ID from the message you replied to.",
          );
        }
      }
      return;
    }

    // 2. CLOSE SUPPORT OVERRIDE
    if (text === "❌ Close Support") {
      await db
        .update(telegramUsers)
        .set({ sessionState: "command" })
        .where(eq(telegramUsers.chatId, chatId));
      ctx.dbState = "command";

      const menuKb = new InlineKeyboard()
        .text("🚀 Get Premium", "menu_premium")
        .row()
        .url("💬 Join Free Chat", "https://t.me/pakakumi_oracle_free")
        .row()
        .text("📖 How to Use", "menu_guide")
        .row()
        .text("📅 My Status", "menu_status")
        .text("💬 Support", "menu_support");

      await ctx.reply(
        "✅ Support closed. You are back in the main menu.\n\n📊 **Pakakumi Oracle**\nChoose an option below:",
        {
          reply_markup: { remove_keyboard: true },
        },
      );
      // Send the inline menu separately so it renders cleanly
      await ctx.reply("Options:", { reply_markup: menuKb });
      return;
    }

    // 3. SUPPORT TICKET CREATION
    if (ctx.dbState === "support") {
      const username = ctx.from?.username || ctx.from?.first_name || "Unknown";

      const [ticket] = await db
        .insert(supportTickets)
        .values({ chatId, message: text.substring(0, 1000) })
        .returning();

      if (ADMIN_CHANNEL_ID) {
        await bot.api.sendMessage(
          ADMIN_CHANNEL_ID,
          `🎫 **New Support Ticket (#${ticket.id})**\n[Ticket from User ID: ${chatId}]\nUsername: @${username}\n\nMessage:\n${text}\n\n_Reply directly to this message to answer the user._`,
          { parse_mode: "Markdown" },
        );
      }

      await ctx.reply(
        "✅ Message sent. An admin will reply here shortly.\n\n_Type another message or click '❌ Close Support'._",
      );
      return;
    }
  });
}
