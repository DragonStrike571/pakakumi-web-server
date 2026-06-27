import { Bot, Context } from "grammy";
import { db } from "../../db/index.js";
import { telegramUsers } from "../../db/schema.js";
import { setupCommands } from "./handlers/commands.js";
import { setupMessages } from "./handlers/messages.js";

// Define custom context
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

// RAM Cache to protect the Database from being hammered by rapid updates
const sessionCache = new Map<string, { state: string; lastUpdated: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 10_000; // Prevent unbounded memory growth

/**
 * Invalidate a user's session cache entry.
 * Call this when session state is changed programmatically (outside middleware).
 */
export function invalidateSessionCache(chatId: string): void {
  sessionCache.delete(chatId);
}

if (bot) {
  // Database State Sync Middleware
  bot.use(async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();

    const chatId = ctx.chat.id.toString();
    const username = ctx.from.username || ctx.from.first_name || "Unknown";
    const now = Date.now();

    // 1. Check RAM Cache first
    const cachedUser = sessionCache.get(chatId);
    if (cachedUser && now - cachedUser.lastUpdated < CACHE_TTL) {
      ctx.dbState = cachedUser.state as "command" | "support";
      return next();
    }

    // 2. If not in cache or TTL expired, hit the Database
    try {
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

      // 3. Update the RAM Cache
      sessionCache.set(chatId, {
        state: user.sessionState,
        lastUpdated: now,
      });

      // Evict oldest entries if cache exceeds max size
      if (sessionCache.size > MAX_CACHE_SIZE) {
        const entries = [...sessionCache.entries()]
          .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
        const toDelete = Math.floor(MAX_CACHE_SIZE * 0.2);
        for (let i = 0; i < toDelete; i++) {
          sessionCache.delete(entries[i][0]);
        }
      }

      ctx.dbState = user.sessionState as "command" | "support";
      await next();
    } catch (error) {
      console.error(`❌ DB Sync Error for user ${chatId}:`, error);
      // Graceful degradation
      ctx.dbState = "command";
      await next();
    }
  });

  // Register Event Handlers
  setupCommands(bot);
  setupMessages(bot);

  // Global Error Boundary
  bot.catch((err) => {
    console.error("❌ Telegram Bot Fatal Error:", err);
  });
}
