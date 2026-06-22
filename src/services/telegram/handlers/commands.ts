import { Bot, InlineKeyboard } from "grammy";
import { MyContext } from "../bot.js";
import { initializePayment } from "../../paystack/paystack.js";
import { db } from "../../../db/index.js";
import { telegramUsers, rounds } from "../../../db/schema.js";
import { eq, desc, gte } from "drizzle-orm";
import { generateAlgorithmBets } from "../../../utils/strategies/core.js";

async function isUserPremium(chatId: string): Promise<boolean> {
  const user = await db
    .select()
    .from(telegramUsers)
    .where(eq(telegramUsers.chatId, chatId))
    .then((res) => res[0]);
  if (!user || !user.expiryTimestamp) return false;
  return user.expiryTimestamp > new Date();
}

async function sendMainMenu(ctx: any) {
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
    "📊 **Pakakumi Oracle**\n\n\n" +
      "We track the game to find the best times to bet.\n\n" +
      "🔧 **Bot Commands:**\n\n" +
      "• `/last <multiplier> [count]`\n_See past hits (e.g., /last 50 3)_\n\n" +
      "• `/generate <capital> <minBet> <multiplier> <targetReturn>`\n_Plan your bets (e.g., /generate 1000 10 2.0 1.5)_\n\n" +
      "• `/terms`\n_Rules and Policies_",
    { parse_mode: "Markdown", reply_markup: menuKb },
  );
}

export function setupCommands(bot: Bot<MyContext>) {
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    await db
      .update(telegramUsers)
      .set({ sessionState: "command" })
      .where(eq(telegramUsers.chatId, chatId));
    ctx.dbState = "command";

    const payload = ctx.match;
    if (payload.startsWith("strat_")) {
      const target = payload.split("_")[1];
      return ctx.reply(
        `⚙️ **Plan Your Bets**\n\n` +
          `You are aiming for a ${target}x multiplier.\n\n` +
          `To plan your stakes, reply with:\n\n` +
          `\`/generate <capital> <minBet> ${target} <targetReturn>\`\n\n` +
          `_Example: /generate 5000 20 ${target} 1.5_`,
        { parse_mode: "Markdown" },
      );
    }

    if (payload === "premium") {
      return triggerPremiumMenu(ctx);
    }

    await sendMainMenu(ctx);
  });

  async function triggerPremiumMenu(ctx: any) {
    const tierKeyboard = new InlineKeyboard()
      .text("1 Day - KES 200", "pay_1_200")
      .row()
      .text("7 Days - KES 1000", "pay_7_1000")
      .row()
      .text("30 Days - KES 3000", "pay_30_3000");

    await ctx.reply(
      "⚡ **Choose your Premium Plan:**\n\n\n" +
        "Get exact targets, live alerts, and full access to the `/last` and `/generate` commands.",
      { parse_mode: "Markdown", reply_markup: tierKeyboard },
    );
  }

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat!.id.toString();

    // Always acknowledge the callback immediately to stop the UI from hanging
    await ctx.answerCallbackQuery().catch(console.error);

    if (data === "menu_premium") return triggerPremiumMenu(ctx);
    if (data === "menu_guide") return triggerGuide(ctx);
    if (data === "menu_status") return checkStatus(ctx);
    if (data === "menu_support") return triggerSupport(ctx);

    if (data.startsWith("pay_")) {
      const [, daysStr, amountStr] = data.split("_");
      const duration = parseInt(daysStr);
      const amountKES = parseInt(amountStr);

      // Notify the user something is happening
      const loadingMsg = await ctx.reply("⏳ Generating your M-Pesa link...");

      try {
        const payment = await initializePayment(
          `user_${chatId}@oracle.internal`,
          amountKES,
          chatId,
          duration,
        );

        if (payment && payment.status) {
          await bot.api.editMessageText(
            chatId,
            loadingMsg.message_id,
            `💳 **Pay via M-Pesa**\n\nPlan: ${duration} Days\n\nClick the link below to pay:\n${payment.data.authorization_url}\n\n_Your access link will be sent automatically after payment._`,
            { parse_mode: "Markdown" },
          );
        } else {
          // Log the exact payload to see why Paystack rejected it
          console.error("❌ Paystack initialization rejected:", payment);
          await bot.api.editMessageText(
            chatId,
            loadingMsg.message_id,
            "❌ Payment could not be generated at this time. Please try again.",
          );
        }
      } catch (error) {
        console.error("❌ Payment Network Error:", error);
        await bot.api.editMessageText(
          chatId,
          loadingMsg.message_id,
          "❌ Payment system is currently busy. Try again in a minute.",
        );
      }
    }
  });

  async function checkStatus(ctx: any) {
    const chatId = ctx.chat!.id.toString();
    const isPremium = await isUserPremium(chatId);
    const user = await db
      .select()
      .from(telegramUsers)
      .where(eq(telegramUsers.chatId, chatId))
      .then((res) => res[0]);

    if (!isPremium) {
      await ctx.reply("❌ **Status:** Not Active", { parse_mode: "Markdown" });
    } else {
      await ctx.reply(
        `✅ **Status:** Active\n\nExpires on:\n*${user.expiryTimestamp?.toDateString()}*`,
        { parse_mode: "Markdown" },
      );
    }
  }

  async function triggerGuide(ctx: any) {
    await ctx.reply(
      "📖 **How to use Pakakumi Oracle**\n\n\n" +
        "1️⃣ **Wait for Alerts:** The Premium channel tells you which targets are hot and when they are expected.\n\n" +
        "2️⃣ **Plan Your Bets:** Click 'Plan My Bets' on the alert. Tell the bot your capital, and it will calculate your exact stakes so you survive the whole action window.\n\n" +
        "3️⃣ **Play Smart:** Follow the bet plan exactly. Do not bet randomly.\n\n\n" +
        "_Target one multiplier, get your profit, and stop._",
      { parse_mode: "Markdown" },
    );
  }

  async function triggerSupport(ctx: any) {
    const chatId = ctx.chat!.id.toString();
    await db
      .update(telegramUsers)
      .set({ sessionState: "support" })
      .where(eq(telegramUsers.chatId, chatId));
    ctx.dbState = "support";

    await ctx.reply(
      "🔒 **Support Open**\n\n\nType your message below. The admin will reply to you here.",
      {
        parse_mode: "Markdown",
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
      return ctx.reply("⚠️ **How to use:**\n\n`/last <multiplier> [count]`", {
        parse_mode: "Markdown",
      });

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
      return ctx.reply(`No records found for >= ${target}x.`);

    if (!isPremium) {
      const hit = history[0];
      const timeAgo = Math.floor(
        (new Date().getTime() - hit.createdAt.getTime()) / 60000,
      );
      let timeString = `${timeAgo} minutes ago`;
      if (timeAgo > 60) timeString = `${Math.floor(timeAgo / 60)} hours ago`;
      if (timeAgo > 1440) timeString = `${Math.floor(timeAgo / 1440)} days ago`;

      return ctx.reply(
        `🔒 **Data Locked**\n\n\n` +
          `The last **${target}x** hit **${timeString}**.\n\n\n` +
          `_Upgrade to Premium to see the exact time and get up to 10 past results._`,
        { parse_mode: "Markdown" },
      );
    }

    let response = `📊 **Past results for >= ${target}x**\n\n\n`;
    history.forEach((hit, index) => {
      const dateStr = hit.createdAt.toLocaleString("en-GB", {
        timeZone: "Africa/Nairobi",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      response += `${index + 1}. **${hit.bust}x**\n_${dateStr}_\n\n`;
    });
    await ctx.reply(response, { parse_mode: "Markdown" });
  });

  bot.command("generate", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (args.length < 4) {
      return ctx.reply(
        "⚠️ **How to use:**\n\n`/generate <capital> <minBet> <multiplier> <targetReturn>`",
        { parse_mode: "Markdown" },
      );
    }

    const [capital, minBet, multiplier, targetReturn] = args.map(parseFloat);
    if ([capital, minBet, multiplier, targetReturn].some(isNaN))
      return ctx.reply("❌ Use numbers only.");

    const isPremium = await isUserPremium(chatId);
    if (!isPremium)
      return ctx.reply(
        "🔒 **Locked**\n\nOnly Premium users can use the bot to plan their bets.",
        { parse_mode: "Markdown" },
      );

    const sequence = generateAlgorithmBets(
      capital,
      minBet,
      multiplier,
      targetReturn,
      "none",
    );
    if (sequence.length === 0)
      return ctx.reply(
        "❌ This plan is impossible with your capital. Try changing the numbers.",
      );

    let response =
      `⚙️ **Your Bet Plan**\n\n` +
      `_Capital: ${capital}_\n` +
      `_Target: ${multiplier}x_\n` +
      `_Recovery: ${targetReturn}x_\n\n\n` +
      `**What to bet:**\n\n`;

    const displayLimit = Math.min(sequence.length, 20);

    for (let i = 0; i < displayLimit; i++) {
      response += `Round ${i + 1}: Bet **${sequence[i].amount}**\n`;
    }

    if (sequence.length > 20)
      response += `\n_...and ${sequence.length - 20} more rounds._\n`;
    response += `\n\n**Total losses you can survive:** ${sequence.length - 1}`;
    await ctx.reply(response, { parse_mode: "Markdown" });
  });

  bot.command("terms", async (ctx) => {
    const legalText = `⚖️ **RULES**\n\n\n**1. NO REFUNDS**\nAll payments are final.\n\n**2. BANS**\nReversing an M-Pesa payment will get you permanently banned.\n\n**3. RISKS**\nThe bot gives you the best chances based on past data, but there are no guarantees. We are not responsible for money lost.\n\n**4. PRIVACY**\nWe do not share your info or track your personal bets.`;
    await ctx.reply(legalText, { parse_mode: "Markdown" });
  });
}
