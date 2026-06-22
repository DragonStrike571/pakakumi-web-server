import { Bot, Context } from "grammy";
import { db } from "../../db/index.js";
import { telegramUsers } from "../../db/schema.js";
import { setupCommands } from "./handlers/commands.js";
import { setupMessages } from "./handlers/messages.js";

// Define custom context bypassing memory sessions entirely
export interface MyContext extends Context {
  dbState: "command" | "support";
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.warn(
    "⚠️ TELEGRAM_BOT_TOKEN is not set. Telegram bot will not start.",
  );
}

export const bot = token ? new Bot<MyContext>(token) : null;

if (bot) {
  // Database State Sync Middleware
  // Fires on every single incoming update to ensure bulletproof session tracking
  bot.use(async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();

    const chatId = ctx.chat.id.toString();
    const username = ctx.from.username || ctx.from.first_name || "Unknown";

    try {
      // Upsert the user and retrieve their current state from the database
      const [user] = await db
        .insert(telegramUsers)
        .values({
          chatId,
          username,
          sessionState: "command",
        })
        .onConflictDoUpdate({
          target: telegramUsers.chatId,
          set: {
            username,
            updatedAt: new Date(),
          },
        })
        .returning({ sessionState: telegramUsers.sessionState });

      // Inject exact DB state into the context for downstream handlers
      ctx.dbState = user.sessionState as "command" | "support";

      await next();
    } catch (error) {
      console.error(`❌ DB Sync Error for user ${chatId}:`, error);
      // Graceful degradation: default to command if DB fails, but don't crash
      ctx.dbState = "command";
      await next();
    }
  });

  // Register Event Handlers
  setupCommands(bot);
  setupMessages(bot);

  // Global Error Boundary to prevent polling thread crashes
  bot.catch((err) => {
    console.error("❌ Telegram Bot Fatal Error:", err);
  });
}
