import type { Bot } from "grammy";

export function getBotUsername(bot: Pick<Bot, "isInited" | "botInfo"> | null): string {
  // botInfo is a throwing getter until grammY has finished initialization.
  return bot?.isInited() ? bot.botInfo.username || "pk_oracle_bot" : "pk_oracle_bot";
}
