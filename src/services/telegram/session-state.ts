import type { Context, MiddlewareFn } from "grammy";

export interface SessionContext extends Context {
  dbState: "command" | "support";
}

export function createSessionStateMiddleware<C extends SessionContext>(
  syncState: (chatId: string, username: string) => Promise<string>,
) {
  const cache = new Map<string, { state: C["dbState"]; lastUpdated: number }>();
  const cacheTtl = 5 * 60 * 1000;
  const maxCacheSize = 10_000;

  const middleware: MiddlewareFn<C> = async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();
    const chatId = ctx.chat.id.toString();
    const username = ctx.from.username || ctx.from.first_name || "Unknown";
    const now = Date.now();
    const cached = cache.get(chatId);

    if (cached && now - cached.lastUpdated < cacheTtl) {
      ctx.dbState = cached.state;
    } else {
      try {
        const state = await syncState(chatId, username);
        ctx.dbState = state === "support" ? "support" : "command";
        cache.set(chatId, { state: ctx.dbState, lastUpdated: now });
        if (cache.size > maxCacheSize) {
          const entries = [...cache.entries()].sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
          for (let i = 0; i < Math.floor(maxCacheSize * 0.2); i++) cache.delete(entries[i][0]);
        }
      } catch (error) {
        console.error(`❌ DB Sync Error for user ${chatId}:`, error);
        ctx.dbState = "command";
      }
    }

    // Downstream command errors belong to bot.catch, not the database fallback.
    // Calling next again after a failed command can repeat its side effects.
    await next();
  };

  return { middleware, invalidate: (chatId: string) => { cache.delete(chatId); } };
}
