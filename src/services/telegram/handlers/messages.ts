import { Bot } from "grammy";
import { MyContext } from "../bot.js";
import { db } from "../../../db/index.js";
import { supportTickets } from "../../../db/schema.js";

const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;

export function setupMessages(bot: Bot<MyContext>) {
  // Catch-all for text messages
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id.toString();

    // 1. Ignore Slash Commands to prevent routing collisions
    if (text.startsWith("/")) return;

    // 2. IS THIS AN ADMIN REPLY?
    if (chatId === ADMIN_CHANNEL_ID) {
      // Check if the admin is natively replying to a forwarded ticket message
      if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
        const originalText = ctx.message.reply_to_message.text;

        // Extract the user ID from our specific formatting block
        const match = originalText.match(/\[Ticket from User ID: (\d+)\]/);

        if (match && match[1]) {
          const targetUserId = match[1];
          try {
            // Forward the admin's reply directly to the user anonymously
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
      // Stop processing here so admin chatter isn't treated as user input
      return;
    }

    // 3. IS THE USER IN SUPPORT MODE?
    if (ctx.dbState === "support") {
      const username = ctx.from.username || ctx.from.first_name || "Unknown";

      // Persist the ticket log locally
      const [ticket] = await db
        .insert(supportTickets)
        .values({
          chatId,
          message: text.substring(0, 1000), // Max length protection
        })
        .returning();

      // Forward to the hidden admin room securely
      if (ADMIN_CHANNEL_ID) {
        await bot.api.sendMessage(
          ADMIN_CHANNEL_ID,
          `🎫 **New Support Ticket (#${ticket.id})**\n` +
            `[Ticket from User ID: ${chatId}]\n` +
            `Username: @${username}\n\n` +
            `Message:\n${text}\n\n` +
            `_Reply directly to this message to answer the user._`,
          { parse_mode: "Markdown" },
        );
      }

      await ctx.reply(
        "✅ Message received. An admin will reply shortly. Type another message or click 'Close Support Ticket'.",
      );
      return;
    }

    // 4. GRACEFUL DEGRADATION
    // If the user types random text while in command mode, just ignore it.
    // Do not spam them with "Command not found", as it creates a poor UX.
  });
}
