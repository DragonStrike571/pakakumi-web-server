import { Bot, InlineKeyboard } from "grammy";
import { MyContext } from "../bot.js";
import { initializePayment } from "../../paystack/paystack.js";
import { db } from "../../../db/index.js";
import { telegramUsers, rounds } from "../../../db/schema.js";
import { eq, desc, gte } from "drizzle-orm";
import { generateAlgorithmBets } from "../../../utils/strategies/core.js";
import { formatRiskMessage } from "../risk.js";

// ─── Pricing — 5 tiers for better conversion ────────────────────────────────
const PRICING_PLANS: Record<string, { days: number; price: number }> = {
  "0.5": { days: 0.5, price: 200 },
  "1": { days: 1, price: 350 },
  "3": { days: 3, price: 800 },
  "7": { days: 7, price: 1500 },
  "30": { days: 30, price: 4000 },
};

// ─── Shared Utilities ───────────────────────────────────────────────────────

async function isUserPremium(chatId: string): Promise<boolean> {
  const user = await db
    .select()
    .from(telegramUsers)
    .where(eq(telegramUsers.chatId, chatId))
    .then((res) => res[0]);
  if (!user || !user.expiryTimestamp) return false;
  return user.expiryTimestamp > new Date();
}

export function buildMainMenuKeyboard(botUsername: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚀 Get Premium", "menu_premium")
    .row()
    .url("💬 Join Free Chat", "https://t.me/pakakumi_oracle_free")
    .row()
    .text("📖 How It Works", "menu_guide")
    .row()
    .text("📅 My Status", "menu_status")
    .text("💬 Support", "menu_support");
}

async function sendMainMenu(ctx: MyContext) {
  const botUsername = ctx.me?.username || "pk_oracle_bot";
  const menuKb = buildMainMenuKeyboard(botUsername);

  await ctx.reply(
    "📊 <b>Pakakumi Oracle</b>\n\n" +
      "We watch the game and tell you the best times to play.\n\n" +
      "🔧 <b>Commands:</b>\n\n" +
      "• <code>/last 50 3</code>\nSee the last 3 times 50x appeared\n\n" +
      "• <code>/generate 1000 10 2.0 1.5</code>\nPlan your bets — tells you exactly how much to stake each round\n\n" +
      "• <code>/plan 5000 2.5</code>\nGet a survival plan for your balance\n\n" +
      "• <code>/terms</code>\nRules and policies",
    { parse_mode: "HTML", reply_markup: menuKb },
  );
}

// ─── Command Setup ──────────────────────────────────────────────────────────

export function setupCommands(bot: Bot<MyContext>) {
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    await db
      .update(telegramUsers)
      .set({ sessionState: "command" })
      .where(eq(telegramUsers.chatId, chatId));
    ctx.dbState = "command";

    const payload = ctx.match;
    if (payload.startsWith("plan_")) {
      const target = payload.replace("plan_", "");
      const msg =
        `🎯 <b>Target: ${target}x</b>\n\n` +
        `Let's plan your bets properly so you don't go broke.\n\n` +
        `How much cash do you have? Type it like this:\n\n` +
        `<code>/plan 1000 ${target}</code>`;
      return ctx.reply(msg, { parse_mode: "HTML" });
    }

    if (payload.startsWith("strat_")) {
      const target = payload.split("_")[1];
      return ctx.reply(
        `⚙️ <b>Plan Your Bets</b>\n\n` +
          `You want to hit ${target}x.\n\n` +
          `Type this to plan your stakes:\n\n` +
          `<code>/generate [your cash] [min bet] ${target} [recovery]</code>\n\n` +
          `<i>Example: /generate 5000 20 ${target} 1.5</i>`,
        { parse_mode: "HTML" },
      );
    }

    if (payload === "paid") {
      return ctx.reply(
        "⏳ If you completed the payment, your Premium access will arrive here in 15-30 seconds.",
      );
    }

    if (payload === "guide") return triggerGuide(ctx);
    if (payload === "premium") return triggerPremiumMenu(ctx);

    await sendMainMenu(ctx);
  });

  async function triggerPremiumMenu(ctx: MyContext) {
    const tierKeyboard = new InlineKeyboard()
      .text(`12 Hours — KES ${PRICING_PLANS["0.5"].price}`, "pay_0.5")
      .row()
      .text(`1 Day — KES ${PRICING_PLANS["1"].price}`, "pay_1")
      .row()
      .text(`3 Days — KES ${PRICING_PLANS["3"].price}`, "pay_3")
      .row()
      .text(`7 Days — KES ${PRICING_PLANS["7"].price}`, "pay_7")
      .row()
      .text(`30 Days — KES ${PRICING_PLANS["30"].price}`, "pay_30");

    await ctx.reply(
      "⚡ <b>Choose Your Plan:</b>\n\n" +
        "Get exact targets, early alerts, and the <code>/last</code> and <code>/generate</code> commands.",
      { parse_mode: "HTML", reply_markup: tierKeyboard },
    );
  }

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat!.id.toString();

    await ctx.answerCallbackQuery().catch(console.error);

    if (data === "menu_premium") return triggerPremiumMenu(ctx);
    if (data === "menu_guide") return triggerGuide(ctx);
    if (data === "menu_status") return checkStatus(ctx);
    if (data === "menu_support") return triggerSupport(ctx);

    if (data.startsWith("pay_")) {
      const [, daysStr] = data.split("_");

      // SECURITY: Validate against backend pricing source of truth
      const plan = PRICING_PLANS[daysStr];
      if (!plan) {
        console.error(`🚨 Invalid plan requested: ${daysStr} by ${chatId}`);
        return;
      }

      const duration = plan.days;
      const amountKES = plan.price;

      const loadingMsg = await ctx.reply("⏳ Preparing your M-Pesa link...");

      try {
        const callbackUrl = `https://t.me/${bot.botInfo.username}?start=paid`;

        const payment = await initializePayment(
          `user_${chatId}@pakakumi-oracle.ke.softdocs.org`,
          amountKES,
          chatId,
          duration,
          callbackUrl,
        );

        if (payment && payment.status) {
          const durationLabel =
            duration < 1 ? "12 Hours" : `${duration} Day${duration > 1 ? "s" : ""}`;

          await bot.api.editMessageText(
            chatId,
            loadingMsg.message_id,
            `💳 <b>Pay with M-Pesa</b>\n\n` +
              `<b>Plan:</b> ${durationLabel}\n` +
              `<b>Price:</b> KES ${amountKES}\n\n` +
              `1️⃣ Click the link below\n` +
              `2️⃣ Enter your M-Pesa number\n` +
              `3️⃣ Enter your PIN when the prompt comes\n\n` +
              `🔗 <b><a href="${payment.data.authorization_url}">Open Payment Page</a></b>\n\n` +
              `<i>⚠️ M-Pesa can take up to 30 seconds to send the prompt. Once you pay, you will get your access link here automatically.</i>`,
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            },
          );
        } else {
          console.error("❌ Paystack initialization rejected:", payment);
          await bot.api.editMessageText(
            chatId,
            loadingMsg.message_id,
            "❌ Could not create payment. Try again in a moment.",
          );
        }
      } catch (error) {
        console.error("❌ Payment Network Error:", error);
        await bot.api.editMessageText(
          chatId,
          loadingMsg.message_id,
          "❌ Payment system is busy. Try again in a minute.",
        );
      }
    }
  });

  async function checkStatus(ctx: MyContext) {
    const chatId = ctx.chat!.id.toString();
    const isPremium = await isUserPremium(chatId);
    const user = await db
      .select()
      .from(telegramUsers)
      .where(eq(telegramUsers.chatId, chatId))
      .then((res) => res[0]);

    if (!isPremium) {
      await ctx.reply("❌ <b>Status:</b> Not Active", { parse_mode: "HTML" });
    } else {
      await ctx.reply(
        `✅ <b>Status:</b> Active\n\nExpires: <b>${user.expiryTimestamp?.toDateString()}</b>`,
        { parse_mode: "HTML" },
      );
    }
  }

  async function triggerGuide(ctx: MyContext) {
    const guideText =
      `📖 <b>How This Works</b>\n\n` +
      `We watch every single game round 24/7 and track when each multiplier last appeared.\n\n` +
      `<b>🎯 What the alerts mean:</b>\n\n` +
      `<b>1️⃣ "5 to 15 games"</b>\n` +
      `The target is expected to appear within this range. Spread your bets across these rounds.\n\n` +
      `<b>2️⃣ "Within 10 games"</b>\n` +
      `The target is very close. It could drop any moment.\n\n` +
      `<b>3️⃣ "Late"</b>\n` +
      `The target should have appeared already but hasn't. This means you need more bets to catch it.\n\n` +
      `<b>💡 The Most Important Thing:</b>\n` +
      `Always click <b>"⚙️ Plan My Bets"</b> on any alert. The bot tells you exactly how much to bet each round so you don't go broke waiting.\n\n` +
      `<b>⚠️ Never</b> put all your money on one round. The plan spreads your cash across many rounds to give you the best chance.`;

    await ctx.reply(guideText, { parse_mode: "HTML" });
  }

  async function triggerSupport(ctx: MyContext) {
    const chatId = ctx.chat!.id.toString();
    await db
      .update(telegramUsers)
      .set({ sessionState: "support" })
      .where(eq(telegramUsers.chatId, chatId));
    ctx.dbState = "support";

    await ctx.reply(
      "🔒 <b>Support Open</b>\n\nType your message below. An admin will reply here.",
      {
        parse_mode: "HTML",
        reply_markup: {
          keyboard: [[{ text: "❌ Close Support" }]],
          resize_keyboard: true,
        },
      },
    );
  }

  bot.command("last", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);
    if (!args[0])
      return ctx.reply(
        "⚠️ <b>How to use:</b>\n\n<code>/last [multiplier] [count]</code>\n\nExample: <code>/last 50 3</code>",
        { parse_mode: "HTML" },
      );

    const target = parseFloat(args[0]);
    const limit = args[1] ? Math.min(parseInt(args[1]), 10) : 1;
    if (isNaN(target) || isNaN(limit)) return ctx.reply("❌ Use numbers only.");

    const isPremium = await isUserPremium(chatId);
    const history = await db
      .select()
      .from(rounds)
      .where(gte(rounds.bust, target))
      .orderBy(desc(rounds.createdAt))
      .limit(isPremium ? limit : 1);

    if (history.length === 0)
      return ctx.reply(`No results found for >= ${target}x.`);

    if (!isPremium) {
      const hit = history[0];
      const timeAgo = Math.floor(
        (new Date().getTime() - hit.createdAt.getTime()) / 60000,
      );
      let timeString = `${timeAgo} minutes ago`;
      if (timeAgo > 60) timeString = `${Math.floor(timeAgo / 60)} hours ago`;
      if (timeAgo > 1440) timeString = `${Math.floor(timeAgo / 1440)} days ago`;

      return ctx.reply(
        `🔒 <b>Limited View</b>\n\n` +
          `The last <b>${target}x</b> was <b>${timeString}</b>.\n\n` +
          `<i>Get Premium to see exact times and up to 10 past results.</i>`,
        { parse_mode: "HTML" },
      );
    }

    let response = `📊 <b>Past results for >= ${target}x</b>\n\n`;
    history.forEach((hit, index) => {
      const dateStr = hit.createdAt.toLocaleString("en-GB", {
        timeZone: "Africa/Nairobi",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      response += `${index + 1}. <b>${hit.bust}x</b>\n<i>${dateStr}</i>\n\n`;
    });
    await ctx.reply(response, { parse_mode: "HTML" });
  });

  bot.command("generate", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (args.length < 4) {
      return ctx.reply(
        "⚠️ <b>How to use:</b>\n\n<code>/generate [cash] [min bet] [multiplier] [recovery]</code>\n\n" +
          "Example: <code>/generate 1000 10 2.0 1.5</code>",
        { parse_mode: "HTML" },
      );
    }

    const [capital, minBet, multiplier, targetReturn] = args.map(parseFloat);
    if ([capital, minBet, multiplier, targetReturn].some(isNaN))
      return ctx.reply("❌ Use numbers only.");

    const isPremium = await isUserPremium(chatId);
    if (!isPremium)
      return ctx.reply(
        "🔒 <b>Premium Only</b>\n\nGet Premium to plan your bets with the bot.",
        { parse_mode: "HTML" },
      );

    const sequence = generateAlgorithmBets(
      capital,
      minBet,
      multiplier,
      targetReturn,
      "five",
    );
    if (sequence.length === 0)
      return ctx.reply(
        "❌ This plan is not possible with your cash. Try different numbers.",
      );

    let response =
      `⚙️ <b>Your Bet Plan</b>\n\n` +
      `<i>Cash: KES ${capital}</i>\n` +
      `<i>Target: ${multiplier}x</i>\n` +
      `<i>Recovery: ${targetReturn}x</i>\n\n` +
      `<b>What to bet each round:</b>\n\n`;

    const displayLimit = Math.min(sequence.length, 20);

    for (let i = 0; i < displayLimit; i++) {
      response += `Round ${i + 1}: Bet <b>KES ${sequence[i].amount}</b>\n`;
    }

    if (sequence.length > 20)
      response += `\n<i>...and ${sequence.length - 20} more rounds.</i>\n`;
    response += `\n<b>Total losses you can survive:</b> ${sequence.length - 1}`;
    await ctx.reply(response, { parse_mode: "HTML" });
  });

  bot.command("plan", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (args.length !== 2) {
      return ctx.reply(
        "❌ <b>Wrong format.</b>\n\nType it like this: <code>/plan [your cash] [target]</code>\nExample: <code>/plan 5000 2.5</code>",
        { parse_mode: "HTML" },
      );
    }

    const bankroll = Number(args[0]);
    const target = Number(args[1]);

    if (isNaN(bankroll) || bankroll < 10) {
      return ctx.reply("❌ Amount too small. Minimum is KES 10.");
    }
    if (isNaN(target) || target <= 1.01) {
      return ctx.reply("❌ Invalid target. Must be above 1.01x.");
    }

    // Premium Validation Check
    const isPremium = await isUserPremium(chatId);
    if (!isPremium) {
      return ctx.reply(
        "🔒 <b>Premium Only</b>\n\nGet Premium to generate survival plans.",
        { parse_mode: "HTML" },
      );
    }

    const riskMsg = formatRiskMessage(bankroll, target);
    await ctx.reply(riskMsg, { parse_mode: "HTML" });
  });

  bot.command("terms", async (ctx) => {
    const legalText =
      `⚖️ <b>RULES</b>\n\n` +
      `<b>1. NO REFUNDS</b>\nAll payments are final.\n\n` +
      `<b>2. BANS</b>\nReversing an M-Pesa payment gets you permanently banned.\n\n` +
      `<b>3. RISKS</b>\nThe bot gives you the best chances based on past data, but nothing is guaranteed. We are not responsible for money lost.\n\n` +
      `<b>4. PRIVACY</b>\nWe don't share your info or track your personal bets.`;
    await ctx.reply(legalText, { parse_mode: "HTML" });
  });
}
