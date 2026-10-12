import { Bot, Context } from "grammy";
import { db } from "../../db/index.js";
import { telegramUsers } from "../../db/schema.js";
import { setupCommands } from "./handlers/commands.js";
import { setupMessages } from "./handlers/messages.js";
import { createSessionStateMiddleware } from "./session-state.js";
import { eq } from "drizzle-orm";

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

export const bot = token ? new Bot<MyContext>(token, { client: { timeoutSeconds: 15 } }) : null;

const sessionState = createSessionStateMiddleware<MyContext>(async (chatId, username) => {
  const [user] = await db
    .insert(telegramUsers)
    .values({ chatId, username, sessionState: "command" })
    .onConflictDoUpdate({
      target: telegramUsers.chatId,
      set: { username, updatedAt: new Date() },
    })
    .returning({ sessionState: telegramUsers.sessionState });
  if (!user) throw new Error("Session sync returned no user");
  return user.sessionState;
});
export const syncTelegramSession = sessionState.middleware;

/**
 * Invalidate a user's session cache entry.
 * Call this when session state is changed programmatically (outside middleware).
 */
export function invalidateSessionCache(chatId: string): void {
  sessionState.invalidate(chatId);
}

export async function setSessionState(ctx: MyContext, state: MyContext["dbState"]) {
  if (!ctx.chat) throw new Error("Session state requires a chat");
  const chatId = String(ctx.chat.id);
  await db.update(telegramUsers).set({ sessionState: state }).where(
    eq(telegramUsers.chatId, chatId),
  );
  sessionState.invalidate(chatId);
  ctx.dbState = state;
}

if (bot) {
  // Database State Sync Middleware
  bot.use(syncTelegramSession);

  // Register Event Handlers
  setupCommands(bot);
  setupMessages(bot);

  // Global Error Boundary
  bot.catch((err) => {
    console.error(`❌ Telegram update ${err.ctx.update.update_id} failed:`, err.error);
  });
}
