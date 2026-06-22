import { Bot, InlineKeyboard } from "grammy";
import { MyContext } from "../bot.js";
import { initializePayment } from "../../paystack/paystack.js";
import { db } from "../../../db/index.js";
import { telegramUsers, rounds } from "../../../db/schema.js";
import { eq, desc, gte } from "drizzle-orm";
import { generateAlgorithmBets } from "../../../utils/strategies/core.js";

// Helper to check if user has active premium access
async function isUserPremium(chatId: string): Promise<boolean> {
  const user = await db
    .select()
    .from(telegramUsers)
    .where(eq(telegramUsers.chatId, chatId))
    .then((res) => res[0]);
  if (!user || !user.expiryTimestamp) return false;
  return user.expiryTimestamp > new Date();
}

export function setupCommands(bot: Bot<MyContext>) {
  // =================================================================
  // 1. CORE MENUS & BILLING (From Phase 2)
  // =================================================================
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    await db
      .update(telegramUsers)
      .set({ sessionState: "command" })
      .where(eq(telegramUsers.chatId, chatId));
    ctx.dbState = "command";

    await ctx.reply(
      "📊 **Pakakumi Oracle Engine**\n\n" +
        "Automated statistical tracking of house variance and multiplier streaks.\n\n" +
        "🔧 **Available Tools:**\n" +
        "`/last <multiplier> [count]` - Find historical hits (e.g., `/last 100 3`)\n" +
        "`/generate <capital> <minBet> <multiplier> <targetReturn>` - Matrix strategy builder\n" +
        "`/terms` - View platform policies",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [
            [{ text: "🚀 Get Premium Signals" }],
            [{ text: "💬 Contact Support" }, { text: "📅 My Status" }],
          ],
          resize_keyboard: true,
        },
      },
    );
  });

  bot.hears("🚀 Get Premium Signals", async (ctx) => {
    const tierKeyboard = new InlineKeyboard()
      .text("1 Day Pass - KES 200", "pay_1_200")
      .row()
      .text("7 Day Pass - KES 1000", "pay_7_1000")
      .row()
      .text("30 Day Pass - KES 3000", "pay_30_3000");

    await ctx.reply(
      "⚡ **Select your Premium Tier:**\n\nAccess real-time, high-confidence entry alerts before the flight starts. Includes full access to `/last` and `/generate` commands.",
      {
        parse_mode: "Markdown",
        reply_markup: tierKeyboard,
      },
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("pay_")) return;

    const [, daysStr, amountStr] = data.split("_");
    const duration = parseInt(daysStr);
    const amountKES = parseInt(amountStr);
    const chatId = ctx.chat!.id.toString();

    await ctx.answerCallbackQuery({
      text: "Generating secure M-Pesa invoice...",
    });

    try {
      const payment = await initializePayment(
        `user_${chatId}@oracle.internal`,
        amountKES,
        chatId,
        duration,
      );
      if (payment && payment.status) {
        await ctx.reply(
          `💳 **Checkout Link Generated**\nTier: ${duration} Days\n\nPay via M-Pesa here:\n${payment.data.authorization_url}\n\n_System will automatically send your access link within 60 seconds of payment._`,
          { parse_mode: "Markdown" },
        );
      }
    } catch (error) {
      console.error("Paystack API Error:", error);
      await ctx.reply(
        "❌ Payment gateway is currently busy. Please try again in a moment.",
      );
    }
  });

  bot.hears("📅 My Status", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const isPremium = await isUserPremium(chatId);
    const user = await db
      .select()
      .from(telegramUsers)
      .where(eq(telegramUsers.chatId, chatId))
      .then((res) => res[0]);

    if (!isPremium) {
      await ctx.reply(
        "❌ **Status:** Inactive / Expired\n\nClick 'Get Premium Signals' to renew access.",
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.reply(
        `✅ **Status:** Active\n\nYour premium access expires on:\n*${user.expiryTimestamp?.toDateString()}*`,
        { parse_mode: "Markdown" },
      );
    }
  });

  // =================================================================
  // 2. THE HISTORICAL DATABASE QUERY (/last)
  // =================================================================
  bot.command("last", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (!args[0]) {
      return ctx.reply(
        "⚠️ **Usage:** `/last <multiplier> [count]`\nExample: `/last 100 3` to see the last three 100x hits.",
        { parse_mode: "Markdown" },
      );
    }

    const target = parseFloat(args[0]);
    const limit = args[1] ? Math.min(parseInt(args[1]), 10) : 1; // Cap at 10 results to prevent spam

    if (isNaN(target) || isNaN(limit)) {
      return ctx.reply("❌ Invalid numbers provided.");
    }

    const isPremium = await isUserPremium(chatId);

    // Query the database
    const history = await db
      .select()
      .from(rounds)
      .where(gte(rounds.bust, target))
      .orderBy(desc(rounds.createdAt))
      .limit(isPremium ? limit : 1); // Free users only ever see 1, regardless of request

    if (history.length === 0) {
      return ctx.reply(
        `No records found for >= ${target}x in the current database window.`,
      );
    }

    // Free User Teaser
    if (!isPremium) {
      const hit = history[0];
      const timeAgo = Math.floor(
        (new Date().getTime() - hit.createdAt.getTime()) / 60000,
      ); // in minutes

      let timeString = `${timeAgo} minutes ago`;
      if (timeAgo > 60) timeString = `${Math.floor(timeAgo / 60)} hours ago`;
      if (timeAgo > 1440) timeString = `${Math.floor(timeAgo / 1440)} days ago`;

      return ctx.reply(
        `🔒 **Historical Data Locked**\n\nThe last **${target}x** occurred roughly **${timeString}**.\n\n` +
          `_Upgrade to Premium to see exact timestamps, historical clusters, and request up to 10 previous occurrences at once._`,
        { parse_mode: "Markdown" },
      );
    }

    // Premium User Full Output
    let response = `📊 **Historical Data for >= ${target}x**\n\n`;
    history.forEach((hit, index) => {
      // Format cleanly: "1. 104.50x - May 24, 14:30 EAT"
      const dateStr = hit.createdAt.toLocaleString("en-GB", {
        timeZone: "Africa/Nairobi",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      response += `${index + 1}. **${hit.bust}x** ─ _${dateStr}_\n`;
    });

    await ctx.reply(response, { parse_mode: "Markdown" });
  });

  // =================================================================
  // 3. THE ALGORITHMIC BET GENERATOR (/generate)
  // =================================================================
  bot.command("generate", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (args.length < 4) {
      return ctx.reply(
        "⚠️ **Usage:** `/generate <capital> <minBet> <multiplier> <targetReturn>`\n" +
          "Example: `/generate 1000 10 2.0 1.5`\n" +
          "_(Capital: 1000, Start Bet: 10, Cashout: 2x, Target Return: 1.5x)_",
        { parse_mode: "Markdown" },
      );
    }

    const [capital, minBet, multiplier, targetReturn] = args.map(parseFloat);

    if ([capital, minBet, multiplier, targetReturn].some(isNaN)) {
      return ctx.reply("❌ Please provide valid numbers for all parameters.");
    }

    const isPremium = await isUserPremium(chatId);

    // Free users are not allowed to use the generator at all
    if (!isPremium) {
      return ctx.reply(
        `🔒 **Tool Locked**\n\nThe Algorithmic Strategy Generator is restricted to Premium users.\n` +
          `It builds mathematically perfect recovery sequences based on your exact capital and risk tolerance.\n\n` +
          `Click 'Get Premium Signals' to unlock.`,
        { parse_mode: "Markdown" },
      );
    }

    const sequence = generateAlgorithmBets(
      capital,
      minBet,
      multiplier,
      targetReturn,
      "none",
    );

    if (sequence.length === 0) {
      return ctx.reply(
        "❌ The parameters provided resulted in an impossible sequence (e.g., min bet is larger than capital). Adjust your numbers.",
      );
    }

    let response =
      `⚙️ **Strategy Matrix Built**\n` +
      `_Capital: ${capital} | Target: ${multiplier}x | Recovery: ${targetReturn}x_\n\n` +
      `**Execution Sequence:**\n`;

    // Cap output to 20 lines to prevent Telegram message length limits
    const displayLimit = Math.min(sequence.length, 20);
    let totalSpent = 0;

    for (let i = 0; i < displayLimit; i++) {
      totalSpent += sequence[i].amount;
      response += `Step ${i + 1}: Bet **${sequence[i].amount}**\n`;
    }

    if (sequence.length > 20) {
      response += `\n_...and ${sequence.length - 20} more steps until capital is depleted._\n`;
    }

    response += `\n**Max Survivable Losses:** ${sequence.length - 1}`;

    await ctx.reply(response, { parse_mode: "Markdown" });
  });

  // =================================================================
  // 4. LEGAL & NOTICES (/terms)
  // =================================================================
  bot.command("terms", async (ctx) => {
    const legalText =
      `⚖️ **PLATFORM TERMS & POLICIES**\n\n` +
      `**1. NO REFUND POLICY**\n` +
      `Due to the real-time, algorithmic nature of the data provided, **all sales are final**. We do not offer refunds, partial or full, for subscription purchases. If you fail to utilize the tool, the payment stands.\n\n` +
      `**2. ANTI-FRAUD NOTIFICATION**\n` +
      `Any attempt to initiate a fraudulent chargeback or M-Pesa reversal will result in an immediate, permanent network ban. Your hardware identifiers and Telegram ID will be blacklisted across all affiliated infrastructure.\n\n` +
      `**3. RISK DISCLOSURE**\n` +
      `The Oracle Engine provides mathematical probabilities based on historical house variance. It does **not** guarantee future outcomes. Trading or gambling relies entirely on your own risk management. We assume zero liability for capital lost.\n\n` +
      `**4. PRIVACY POLICY**\n` +
      `We maintain a zero-knowledge footprint. We do not track your bets, link your Telegram ID to social profiles, or sell your data. Your interaction with this bot is isolated and secure.\n\n` +
      `_By utilizing this bot or executing a payment, you implicitly agree to these terms._`;

    await ctx.reply(legalText, { parse_mode: "Markdown" });
  });

  // =================================================================
  // 5. SUPPORT ROUTER (From Phase 2)
  // =================================================================
  bot.hears("💬 Contact Support", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    await db
      .update(telegramUsers)
      .set({ sessionState: "support" })
      .where(eq(telegramUsers.chatId, chatId));
    ctx.dbState = "support";

    await ctx.reply(
      "🔒 **Secure Support Desk Open**\n\nYou are now in a direct line to administration. Type your inquiry below.\n\n_Click the button below to close the ticket when done._",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "❌ Close Support Ticket" }]],
          resize_keyboard: true,
        },
      },
    );
  });

  bot.hears("❌ Close Support Ticket", async (ctx) => {
    const chatId = ctx.chat!.id.toString();

    if (ctx.dbState === "support") {
      await db
        .update(telegramUsers)
        .set({ sessionState: "command" })
        .where(eq(telegramUsers.chatId, chatId));
      ctx.dbState = "command";

      await ctx.reply(
        "✅ Ticket closed. You have been returned to the main menu.",
        {
          reply_markup: {
            keyboard: [
              [{ text: "🚀 Get Premium Signals" }],
              [{ text: "💬 Contact Support" }, { text: "📅 My Status" }],
            ],
            resize_keyboard: true,
          },
        },
      );
    }
  });
}
