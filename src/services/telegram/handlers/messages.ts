import { Bot } from "grammy";
import { MyContext } from "../bot.js";
import { db } from "../../../db/index.js";
import { supportTickets } from "../../../db/schema.js";

const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;

export function setupMessages(bot: Bot<MyContext>) {
  bot.on("message:text", async (ctx) => {
    // Type guard to satisfy TypeScript
    if (!ctx.message || !ctx.message.text) return;

    const text = ctx.message.text;
    const chatId = ctx.chat.id.toString();

    if (text.startsWith("/")) return;

    if (chatId === ADMIN_CHANNEL_ID) {
      // Use optional chaining here
      if (ctx.message?.reply_to_message?.text) {
        const originalText = ctx.message.reply_to_message.text;
        const match = originalText.match(/\[Ticket from User ID: (\d+)\]/);

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
            console.error("Error sending reply to user:", err);
            await ctx.reply(
              "❌ Failed to send reply. The user may have blocked the bot.",
            );
          }
        }
      }
      return;
    }

    if (ctx.dbState === "support") {
      const username = ctx.from.username || ctx.from.first_name || "Unknown";

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
        "✅ Message received. An admin will reply shortly. Type another message or click '❌ Close Support'.",
      );
      return;
    }
  });
}
