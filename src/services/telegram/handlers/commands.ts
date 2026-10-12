/**
 * Telegram Command Handlers
 *
 * All bot commands: /start, /last, /generate, /plan, /today, /analyze,
 * /howtobet, /terms, and callback query handlers.
 *
 * Design principles:
 * - Simple, non-technical language for standard Kenyan users
 * - Input validation with sane caps on all parameters
 * - Strategy bet plans with aggregated same-amount rounds
 * - Inline quick explanations + full /howtobet guide
 * - Proactive bot.api calls use the global rate limiter
 */

import { Bot, InlineKeyboard } from "grammy";
import { type MyContext, setSessionState } from "../bot.js";
import { requestPremiumInvite } from "../outbox.js";
import { escapeHtml, truncateHtml } from "../../../utils/html.js";
import { initializePayment } from "../../paystack/paystack.js";
import { db } from "../../../db/index.js";
import { telegramUsers, rounds } from "../../../db/schema.js";
import { eq, desc, gte } from "drizzle-orm";
import { generateAlgorithmBets } from "../../../utils/strategies/core.js";
import { formatRiskMessage } from "../risk.js";
import { rateLimitedSend, rateLimitedEdit } from "../rate-limiter.js";
import {
  runCustomAnalysis,
  getTodayStats,
} from "../../analysis/engine.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum Telegram message length */
const MAX_MSG_LENGTH = 4096;

/** Input validation caps */
const MAX_MULTIPLIER = 3000;
const MAX_CAPITAL = 10_000_000;
const MIN_BET = 5;
const MAX_LAST_COUNT = 10;
const MAX_ANALYZE_ROUNDS_FREE = 20;
const MAX_ANALYZE_ROUNDS_PREMIUM = 500;

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

/**
 * Truncate a message to Telegram's max length.
 */
function truncateMessage(text: string): string {
  return truncateHtml(text, MAX_MSG_LENGTH);
}

/**
 * Aggregate consecutive same-amount bets into ranges.
 * e.g., [10, 10, 10, 15, 15, 20] → "Rounds 1-3: KES 10 each\nRounds 4-5: KES 15 each\nRound 6: KES 20"
 */
function aggregateBets(
  sequence: { amount: number; cashout: number }[],
  maxDisplay: number = 30,
): { lines: string[]; totalRounds: number; hiddenRounds: number } {
  const lines: string[] = [];
  let i = 0;
  const limit = Math.min(sequence.length, maxDisplay);

  while (i < limit) {
    const amount = sequence[i].amount;
    let rangeEnd = i;

    // Find the end of this same-amount group
    while (rangeEnd + 1 < limit && sequence[rangeEnd + 1].amount === amount) {
      rangeEnd++;
    }

    if (i === rangeEnd) {
      lines.push(`Round ${i + 1}: Bet <b>KES ${amount.toLocaleString()}</b>`);
    } else {
      lines.push(
        `Rounds ${i + 1}-${rangeEnd + 1}: Bet <b>KES ${amount.toLocaleString()}</b> each`,
      );
    }

    i = rangeEnd + 1;
  }

  return {
    lines,
    totalRounds: sequence.length,
    hiddenRounds: Math.max(0, sequence.length - maxDisplay),
  };
}

/**
 * Format a human-readable remaining time string.
 * e.g., "3 days, 4 hours left"
 */
function formatTimeRemaining(expiryDate: Date): string {
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();

  if (diffMs <= 0) return "Expired";

  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (days === 0 && minutes > 0)
    parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);

  return parts.join(", ") + " left";
}

export function buildMainMenuKeyboard(botUsername: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚀 Get Premium", "menu_premium")
    .row()
    .url("💬 Join Free Chat", "https://t.me/pakakumi_oracle_free")
    .row()
    .text("📊 Today's Results", "menu_today")
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
      "We watch the game 24/7 and tell you the best times to play.\n\n" +
      "🔧 <b>What You Can Do:</b>\n\n" +
      "• <code>/today</code>\nSee today's predictions and how many hit ✅\n\n" +
      "• <code>/last 50 3</code>\nSee the last 3 times 50x appeared\n\n" +
      "• <code>/analyze 100</code>\nAnalyze the last 100 rounds for patterns\n\n" +
      "• <code>/generate 1000 10 2.0 1.5</code>\nGet a bet plan — tells you exactly how much to stake each round\n\n" +
      "• <code>/plan 5000 2.5</code>\nGet a survival plan for your balance\n\n" +
      "• <code>/howtobet</code>\nLearn how to read and use bet plans\n\n" +
      "• <code>/terms</code>\nRules and policies",
    { parse_mode: "HTML", reply_markup: menuKb },
  );
}

// ─── Command Setup ──────────────────────────────────────────────────────────

export function setupCommands(bot: Bot<MyContext>) {
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    await setSessionState(ctx, "command");

    const payload = ctx.match;
    if (payload.startsWith("plan_")) {
      const target = escapeHtml(payload.replace("plan_", ""));
      const msg =
        `🎯 <b>Target: ${target}x</b>\n\n` +
        `Let's plan your bets properly so you don't go broke.\n\n` +
        `How much cash do you have? Type it like this:\n\n` +
        `<code>/plan 1000 ${target}</code>`;
      return ctx.reply(msg, { parse_mode: "HTML" });
    }

    if (payload.startsWith("strat_")) {
      const target = escapeHtml(payload.split("_")[1] ?? "");
      return ctx.reply(
        `⚙️ <b>Plan Your Bets</b>\n\n` +
          `You want to hit ${target}x.\n\n` +
          `Type this to plan your stakes:\n\n` +
          `<code>/generate [your cash] [min bet] ${target} [profit target]</code>\n\n` +
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
        "Get exact targets, early alerts, and the <code>/last</code>, <code>/generate</code>, and <code>/analyze</code> commands.",
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
    if (data === "menu_today") return handleToday(ctx);

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

          await rateLimitedEdit(
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
            "high",
          );
        } else {
          console.error("❌ Paystack initialization rejected:", payment);
          await rateLimitedEdit(
            chatId,
            loadingMsg.message_id,
            "❌ Could not create payment. Try again in a moment.",
            undefined,
            "normal",
          );
        }
      } catch (error) {
        console.error("❌ Payment Network Error:", error);
        await rateLimitedEdit(
          chatId,
          loadingMsg.message_id,
          "❌ Payment system is busy. Try again in a minute.",
          undefined,
          "normal",
        );
      }
    }
  });

  // ─── /status (callback handler) ─────────────────────────────────────────

  async function checkStatus(ctx: MyContext) {
    const chatId = ctx.chat!.id.toString();
    const isPremium = await isUserPremium(chatId);
    const user = await db
      .select()
      .from(telegramUsers)
      .where(eq(telegramUsers.chatId, chatId))
      .then((res) => res[0]);

    if (!isPremium) {
      await ctx.reply(
        "❌ <b>Status:</b> Not Active\n\n" +
          "🔓 <b>What you get with Premium:</b>\n" +
          "• Exact target alerts before they hit\n" +
          "• Full <code>/last</code> history (up to 10 results)\n" +
          "• <code>/generate</code> and <code>/plan</code> bet planning\n" +
          "• Full <code>/analyze</code> access (up to 500 rounds)\n" +
          "• Access to the live Premium channel\n\n" +
          "Type <code>/start</code> to see pricing.",
        { parse_mode: "HTML" },
      );
    } else {
      const timeLeft = user.expiryTimestamp
        ? formatTimeRemaining(user.expiryTimestamp)
        : "Unknown";
      await requestPremiumInvite(chatId);

      await ctx.reply(
        `✅ <b>Status:</b> Active\n\n` +
          `📅 <b>Expires:</b> ${user.expiryTimestamp?.toDateString()}\n` +
          `⏳ <b>Time Left:</b> ${timeLeft}\n\nA fresh Premium Room invite is queued for delivery.`,
        { parse_mode: "HTML" },
      );
    }
  }

  // ─── /guide (callback handler) ──────────────────────────────────────────

  async function triggerGuide(ctx: MyContext) {
    const guideText =
      `📖 <b>How Pakakumi Oracle Works</b>\n\n` +
      `We watch every single game round 24/7 and track when each multiplier last appeared. ` +
      `Using pattern analysis, we predict when specific targets are most likely to show up.\n\n` +
      `<b>🎯 Understanding the Alerts:</b>\n\n` +
      `<b>1️⃣ "5 to 15 games"</b>\n` +
      `The target is expected to appear within this range of rounds. ` +
      `Spread your bets across these rounds — don't dump everything on one.\n\n` +
      `<b>2️⃣ "Within 10 games"</b>\n` +
      `The target is very close. It could drop any moment. ` +
      `This is a strong signal.\n\n` +
      `<b>3️⃣ "Late"</b>\n` +
      `The target should have appeared already but hasn't. ` +
      `The timing is unpredictable, so use smaller bets and extra patience.\n\n` +
      `<b>4️⃣ "Ideal Plan: Budget for X rounds"</b>\n` +
      `This is the number of rounds you should ideally prepare for. ` +
      `It includes the expected window PLUS a safety buffer based on the target size. ` +
      `Always plan for this number, not the minimum.\n\n` +
      `<b>📊 Available Commands:</b>\n\n` +
      `• <code>/today</code> — See today's predictions and accuracy\n` +
      `• <code>/last 50 3</code> — When did 50x last appear? (shows 3 results)\n` +
      `• <code>/analyze 100</code> — Analyze the last 100 rounds for patterns\n` +
      `• <code>/generate 1000 10 2.0 1.5</code> — Get a detailed bet plan\n` +
      `• <code>/plan 5000 2.5</code> — Get a survival plan for your balance\n` +
      `• <code>/howtobet</code> — Full guide on reading and using bet plans\n\n` +
      `<b>⚠️ Common Mistakes to Avoid:</b>\n\n` +
      `❌ Betting all your money on one round\n` +
      `❌ Ignoring the bet plan and betting random amounts\n` +
      `❌ Chasing losses after the plan runs out\n` +
      `❌ Not using <code>/generate</code> to plan before you start\n\n` +
      `<b>💡 The Golden Rule:</b>\n` +
      `Always click <b>"⚙️ Plan My Bets"</b> on any alert. ` +
      `The bot tells you exactly how much to bet each round so you don't go broke waiting.`;

    await ctx.reply(truncateMessage(guideText), { parse_mode: "HTML" });
  }

  // ─── /support (callback handler) ────────────────────────────────────────

  async function triggerSupport(ctx: MyContext) {
    const chatId = ctx.chat!.id.toString();
    await setSessionState(ctx, "support");

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

  // ─── /today — Daily predictions showcase ────────────────────────────────

  async function handleToday(ctx: MyContext) {
    try {
      const chatId = ctx.chat!.id.toString();
      const isPremium = await isUserPremium(chatId);
      const stats = await getTodayStats();

      const today = new Date().toLocaleDateString("en-GB", {
        timeZone: "Africa/Nairobi",
        day: "numeric",
        month: "short",
        year: "numeric",
      });

      const waiting = stats.totalPredictions - stats.totalHits - stats.totalMisses;

      let msg =
        `📊 <b>Today's Predictions</b> (${today})\n\n` +
        `🎯 <b>Predictions Made:</b> ${stats.totalPredictions}\n` +
        `✅ <b>Correct:</b> ${stats.totalHits}\n` +
        `❌ <b>Missed:</b> ${stats.totalMisses}\n`;

      // Only show waiting count to premium users
      if (isPremium) {
        msg += `⏳ <b>Waiting:</b> ${waiting}\n`;
      }

      msg += `\n📈 <b>Today's Accuracy:</b> ${stats.accuracy}%\n`;

      // Show recent target details (last 10)
      if (stats.targets && stats.targets.length > 0) {
        msg += `\n<b>Recent Targets:</b>\n`;

        // Filter targets: free users only see resolved predictions
        const allTargets = stats.targets.slice(-10).reverse();
        const recentTargets = isPremium
          ? allTargets
          : allTargets.filter((t) => t.resolved);

        for (const t of recentTargets) {
          if (t.resolved && t.hit) {
            msg += `✅ ${t.target}x — Hit in ${t.roundsToHit || "?"} rounds\n`;
          } else if (t.resolved && !t.hit) {
            msg += `❌ ${t.target}x — Missed\n`;
          } else {
            msg += `⏳ ${t.target}x — Waiting...\n`;
          }
        }

        if (!isPremium && waiting > 0) {
          msg += `\n🔒 <i>${waiting} live prediction${waiting !== 1 ? "s" : ""} hidden. Get Premium to see targets before they resolve.</i>\n`;
        }
      }

      if (stats.totalPredictions === 0) {
        msg += `\n<i>No predictions yet today. The bot is watching and will alert when patterns emerge.</i>`;
      }

      await ctx.reply(truncateMessage(msg), { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error in /today:", err);
      await ctx.reply("❌ Could not load today's stats. Try again in a moment.");
    }
  }

  bot.command("today", async (ctx) => {
    await handleToday(ctx);
  });

  // ─── /last — Past occurrences lookup ────────────────────────────────────

  bot.command("last", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);
    if (!args[0])
      return ctx.reply(
        "⚠️ <b>How to use:</b>\n\n<code>/last [multiplier] [count]</code>\n\nExample: <code>/last 50 3</code>\n\n<i>This shows you when a specific multiplier last appeared.</i>",
        { parse_mode: "HTML" },
      );

    const target = parseFloat(args[0]);
    const limit = args[1] ? Math.min(parseInt(args[1]), MAX_LAST_COUNT) : 1;

    if (isNaN(target) || isNaN(limit) || target <= 0 || limit <= 0) {
      return ctx.reply("❌ Use positive numbers only. Example: <code>/last 50 3</code>", {
        parse_mode: "HTML",
      });
    }

    if (target > MAX_MULTIPLIER) {
      return ctx.reply(
        `❌ Maximum multiplier is ${MAX_MULTIPLIER}x. Example: <code>/last 100 3</code>`,
        { parse_mode: "HTML" },
      );
    }

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
          `<i>Get Premium to see exact times and up to ${MAX_LAST_COUNT} past results.</i>`,
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
    await ctx.reply(truncateMessage(response), { parse_mode: "HTML" });
  });

  // ─── /analyze — Custom round analysis ───────────────────────────────────

  bot.command("analyze", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (!args[0]) {
      return ctx.reply(
        "⚠️ <b>How to use:</b>\n\n" +
          "<code>/analyze [rounds]</code> — Analyze the last N rounds\n" +
          "<code>/analyze [start] [end]</code> — Analyze a specific range\n\n" +
          "Examples:\n" +
          "• <code>/analyze 50</code> — Last 50 rounds\n" +
          "• <code>/analyze 100 200</code> — Rounds 100 to 200 ago\n\n" +
          "<i>This shows you which multipliers are running hot or cold.</i>",
        { parse_mode: "HTML" },
      );
    }

    const isPremium = await isUserPremium(chatId);
    const maxRounds = isPremium ? MAX_ANALYZE_ROUNDS_PREMIUM : MAX_ANALYZE_ROUNDS_FREE;

    let roundCount: number;
    let startOffset = 0;

    if (args.length >= 2) {
      // Range mode: /analyze 100 200
      const rangeStart = parseInt(args[0]);
      const rangeEnd = parseInt(args[1]);

      if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeStart <= 0 || rangeEnd <= 0) {
        return ctx.reply("❌ Use positive numbers only. Example: <code>/analyze 100 200</code>", {
          parse_mode: "HTML",
        });
      }

      if (rangeStart >= rangeEnd) {
        return ctx.reply("❌ The first number must be smaller than the second. Example: <code>/analyze 100 200</code>", {
          parse_mode: "HTML",
        });
      }

      roundCount = Math.min(rangeEnd - rangeStart, maxRounds);
      startOffset = rangeStart;
    } else {
      // Simple mode: /analyze 100
      roundCount = parseInt(args[0]);
      if (isNaN(roundCount) || roundCount <= 0) {
        return ctx.reply("❌ Use a positive number. Example: <code>/analyze 100</code>", {
          parse_mode: "HTML",
        });
      }
      roundCount = Math.min(roundCount, maxRounds);
    }

    if (!isPremium && roundCount > MAX_ANALYZE_ROUNDS_FREE) {
      roundCount = MAX_ANALYZE_ROUNDS_FREE;
    }

    const result = runCustomAnalysis(roundCount, startOffset);

    if (!result) {
      return ctx.reply("❌ Not enough round data available yet. Try again later.");
    }

    let msg =
      `🔍 <b>Round Analysis</b> (${result.roundCount} rounds)\n\n` +
      `📈 <b>Highest:</b> ${result.highest}x\n` +
      `📉 <b>Lowest:</b> ${result.lowest}x\n` +
      `📊 <b>Average:</b> ${result.average}x\n` +
      `📊 <b>Median:</b> ${result.median}x\n\n`;

    // Distribution table
    msg += `<b>Multiplier Distribution:</b>\n`;
    for (const tier of result.multiplierDistribution) {
      const indicator =
        tier.status === "hot" ? "🔥" : tier.status === "cold" ? "🧊" : "  ";
      msg += `${indicator} ${tier.tier}: <b>${tier.count}</b> (expected ~${tier.expected})\n`;
    }

    // Hot multipliers
    if (result.hotMultipliers.length > 0) {
      msg += `\n🔥 <b>Running Hot:</b>\n`;
      for (const hot of result.hotMultipliers) {
        msg += `• ${hot}\n`;
      }
    }

    // Cold multipliers
    if (result.coldMultipliers.length > 0) {
      msg += `\n🧊 <b>Running Cold:</b>\n`;
      for (const cold of result.coldMultipliers) {
        msg += `• ${cold}\n`;
      }
    }

    if (!isPremium) {
      msg += `\n<i>Free users can analyze up to ${MAX_ANALYZE_ROUNDS_FREE} rounds. Get Premium for up to ${MAX_ANALYZE_ROUNDS_PREMIUM} rounds.</i>`;
    }

    await ctx.reply(truncateMessage(msg), { parse_mode: "HTML" });
  });

  // ─── /generate — Bet plan generator ─────────────────────────────────────

  bot.command("generate", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (args.length < 4) {
      return ctx.reply(
        "⚠️ <b>How to use:</b>\n\n" +
          "<code>/generate [cash] [min bet] [multiplier] [profit target]</code>\n\n" +
          "Example: <code>/generate 1000 10 2.0 1.5</code>\n\n" +
          "<i>This tells you exactly how much to bet each round so you can survive long enough to hit your target.</i>\n\n" +
          "<b>What the numbers mean:</b>\n" +
          "• <b>Cash:</b> How much money you have\n" +
          "• <b>Min bet:</b> Smallest bet you want to start with\n" +
          "• <b>Multiplier:</b> The target you're aiming for (e.g., 2.0x)\n" +
          "• <b>Profit target:</b> How much profit you want when you hit (1.5 = 50% profit)",
        { parse_mode: "HTML" },
      );
    }

    const [capital, minBet, multiplier, targetReturn] = args.map(parseFloat);

    if ([capital, minBet, multiplier, targetReturn].some(isNaN)) {
      return ctx.reply("❌ Use numbers only. Example: <code>/generate 1000 10 2.0 1.5</code>", {
        parse_mode: "HTML",
      });
    }

    // Input validation caps
    if (capital <= 0 || capital > MAX_CAPITAL) {
      return ctx.reply(`❌ Cash must be between 1 and ${MAX_CAPITAL.toLocaleString()}.`);
    }
    if (minBet < MIN_BET) {
      return ctx.reply(`❌ Minimum bet must be at least KES ${MIN_BET}.`);
    }
    if (multiplier <= 1.01 || multiplier > MAX_MULTIPLIER) {
      return ctx.reply(`❌ Multiplier must be between 1.01x and ${MAX_MULTIPLIER}x.`);
    }
    if (targetReturn <= 0 || targetReturn > 100) {
      return ctx.reply("❌ Profit target must be between 0.1 and 100.");
    }

    const isPremium = await isUserPremium(chatId);
    if (!isPremium)
      return ctx.reply(
        "🔒 <b>Premium Only</b>\n\nGet Premium to plan your bets with the bot.\n\nType <code>/start</code> to see pricing.",
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
        "❌ This plan is not possible with your cash. Try a lower target or higher starting amount.",
      );

    // Aggregate same-amount bets
    const { lines, totalRounds, hiddenRounds } = aggregateBets(sequence);

    let response =
      `⚙️ <b>Your Bet Plan</b>\n\n` +
      `<i>Cash: KES ${capital.toLocaleString()}</i>\n` +
      `<i>Target: ${multiplier}x</i>\n` +
      `<i>Profit target: ${targetReturn}x profit when you hit</i>\n\n` +
      `<b>What to bet each round:</b>\n\n`;

    response += lines.join("\n") + "\n";

    if (hiddenRounds > 0) {
      response += `\n<i>...and ${hiddenRounds} more rounds.</i>\n`;
    }

    response +=
      `\n<b>Total rounds you can survive:</b> ${totalRounds - 1}\n\n` +
      `──────────────────\n` +
      `📖 <b>Quick Guide:</b>\n` +
      `• Start from Round 1, go in order\n` +
      `• Set your cashout to <b>${multiplier}x</b> every round\n` +
      `• If you <b>WIN</b> at any point — <b>STOP</b>. You've made profit\n` +
      `• If you reach the last round — <b>STOP</b>. Don't chase\n` +
      `• Amounts increase because each round covers all previous losses\n\n` +
      `<i>Type /howtobet for the full guide on using bet plans.</i>`;

    await ctx.reply(truncateMessage(response), { parse_mode: "HTML" });
  });

  // ─── /plan — Survival plan ──────────────────────────────────────────────

  bot.command("plan", async (ctx) => {
    const chatId = ctx.chat!.id.toString();
    const args = ctx.match.trim().split(/\s+/);

    if (args.length !== 2) {
      return ctx.reply(
        "❌ <b>Wrong format.</b>\n\n" +
          "Type it like this: <code>/plan [your cash] [target]</code>\n" +
          "Example: <code>/plan 5000 2.5</code>\n\n" +
          "<i>This gives you a safe betting plan that protects your balance.</i>",
        { parse_mode: "HTML" },
      );
    }

    const bankroll = Number(args[0]);
    const target = Number(args[1]);

    if (isNaN(bankroll) || bankroll < 10 || bankroll > MAX_CAPITAL) {
      return ctx.reply(`❌ Amount must be between KES 10 and ${MAX_CAPITAL.toLocaleString()}.`);
    }
    if (isNaN(target) || target <= 1.01 || target > MAX_MULTIPLIER) {
      return ctx.reply(`❌ Target must be between 1.01x and ${MAX_MULTIPLIER}x.`);
    }

    // Premium Validation Check
    const isPremium = await isUserPremium(chatId);
    if (!isPremium) {
      return ctx.reply(
        "🔒 <b>Premium Only</b>\n\nGet Premium to generate survival plans.\n\nType <code>/start</code> to see pricing.",
        { parse_mode: "HTML" },
      );
    }

    const riskMsg = formatRiskMessage(bankroll, target);

    // Add inline quick guide
    const fullMsg =
      riskMsg +
      `\n\n──────────────────\n` +
      `📖 <b>Quick Guide:</b>\n` +
      `• Follow the bets in order, one per round\n` +
      `• Set cashout to <b>${target}x</b> each time\n` +
      `• <b>Stop immediately</b> after you win — that's your profit\n` +
      `• If you lose all bets, <b>walk away</b>. Come back later\n\n` +
      `<i>Type /howtobet for the full breakdown.</i>`;

    await ctx.reply(truncateMessage(fullMsg), { parse_mode: "HTML" });
  });

  // ─── /howtobet — Full betting guide ─────────────────────────────────────

  bot.command("howtobet", async (ctx) => {
    const guideMsg =
      `📖 <b>HOW TO USE BET PLANS</b>\n\n` +
      `This guide explains everything about the bet plans from <code>/generate</code> and <code>/plan</code>.\n\n` +
      `──────────────────\n\n` +
      `<b>1️⃣ WHAT THE NUMBERS MEAN</b>\n\n` +
      `When you type <code>/generate 1000 10 2.0 1.5</code>:\n\n` +
      `• <b>1000</b> = Your total cash (KES 1,000)\n` +
      `• <b>10</b> = Your smallest bet (KES 10)\n` +
      `• <b>2.0</b> = Your target multiplier (2x)\n` +
      `• <b>1.5</b> = Your recovery target (you want to get back 1.5x what you've spent)\n\n` +
      `The bot then calculates exactly how much to bet each round.\n\n` +
      `──────────────────\n\n` +
      `<b>2️⃣ WHY AMOUNTS INCREASE</b>\n\n` +
      `Each round's bet is calculated to recover ALL previous losses PLUS your desired profit.\n\n` +
      `Example with 2x target:\n` +
      `• Round 1: Bet KES 10. If 2x hits, you win KES 20 (profit: KES 10)\n` +
      `• Round 2: Bet KES 15. If 2x hits, you win KES 30 (covers Round 1 loss + profit)\n` +
      `• Round 3: Bet KES 25. If 2x hits, you win KES 50 (covers Round 1+2 losses + profit)\n\n` +
      `This is why each bet is bigger — it needs to pay for everything before it.\n\n` +
      `──────────────────\n\n` +
      `<b>3️⃣ WHAT IS "PROFIT TARGET"?</b>\n\n` +
      `The profit target number controls how much profit you make when you hit.\n\n` +
      `• <b>1.0</b> = Break even (just get your money back)\n` +
      `• <b>1.5</b> = 50% profit on top of your losses\n` +
      `• <b>2.0</b> = 100% profit (double your total spent)\n\n` +
      `Higher profit target = higher profit but fewer rounds you can survive.\n` +
      `Lower profit target = less profit but you can survive more rounds.\n\n` +
      `<i>💡 Tip: 1.5 is the sweet spot for most people.</i>\n\n` +
      `──────────────────\n\n` +
      `<b>4️⃣ HOW TO FOLLOW THE PLAN</b>\n\n` +
      `Step by step:\n\n` +
      `1. Look at the "Rounds" line (e.g., "Rounds 1-3: Bet KES 10 each")\n` +
      `2. Go to Pakakumi and bet that exact amount\n` +
      `3. Set your cashout to the target multiplier\n` +
      `4. If you <b>WIN</b> → STOP. Collect your profit. You're done.\n` +
      `5. If you <b>LOSE</b> → Move to the next line and bet that amount\n` +
      `6. If you reach the last round and lose → STOP. Walk away.\n\n` +
      `──────────────────\n\n` +
      `<b>5️⃣ COMMON MISTAKES</b>\n\n` +
      `❌ <b>Betting random amounts:</b> The plan only works if you follow the exact amounts.\n\n` +
      `❌ <b>Continuing after the plan ends:</b> If all rounds are used, you are at your loss limit. STOP.\n\n` +
      `❌ <b>Using all your money:</b> The plan already uses your full cash. Don't add more.\n\n` +
      `❌ <b>Changing the cashout:</b> Always use the same target multiplier for every round.\n\n` +
      `❌ <b>Skipping rounds:</b> Each bet is calculated based on the ones before it.\n\n` +
      `──────────────────\n\n` +
      `<b>6️⃣ WHICH PLAN IS RIGHT FOR ME?</b>\n\n` +
      `• <b>Small budget (under KES 500):</b> Use lower targets like 2x or 3x\n` +
      `• <b>Medium budget (KES 500-5000):</b> Try 5x to 10x targets\n` +
      `• <b>Large budget (KES 5000+):</b> You can go for 20x+ targets\n\n` +
      `The more rounds you can survive, the better your chances. ` +
      `Always aim for at least 15+ rounds of survival.`;

    await ctx.reply(truncateMessage(guideMsg), { parse_mode: "HTML" });
  });

  // ─── /terms ─────────────────────────────────────────────────────────────

  bot.command("terms", async (ctx) => {
    const legalText =
      `⚖️ <b>RULES</b>\n\n` +
      `<b>1. NO REFUNDS</b>\nAll payments are final.\n\n` +
      `<b>2. BANS</b>\nReversing an M-Pesa payment gets you permanently banned.\n\n` +
      `<b>3. RISKS</b>\nThe bot gives you the best chances based on past data, but nothing is guaranteed. We are not responsible for money lost.\n\n` +
      `<b>4. PRIVACY</b>\nWe don't share your info or track your personal bets.`;
    await ctx.reply(legalText, { parse_mode: "HTML" });
  });

  // ─── /lugha — Toggle between English and Swahili ──────────────────────

  bot.command("lugha", async (ctx) => {
    const chatId = ctx.chat!.id.toString();

    // Get current language
    const user = await db
      .select({ language: telegramUsers.language })
      .from(telegramUsers)
      .where(eq(telegramUsers.chatId, chatId))
      .then((res) => res[0]);

    const currentLang = user?.language || "en";
    const newLang = currentLang === "en" ? "sw" : "en";

    await db
      .update(telegramUsers)
      .set({ language: newLang })
      .where(eq(telegramUsers.chatId, chatId));

    if (newLang === "sw") {
      await ctx.reply(
        `🇰🇪 <b>Lugha imebadilishwa kuwa Kiswahili</b>\n\n` +
          `Sasa utapokea ujumbe muhimu kwa Kiswahili.\n\n` +
          `📌 Amri zote zinabaki sawa: /start, /today, /generate, /plan, /analyze\n\n` +
          `Bonyeza /lugha tena kubadilisha kurudi kwa Kiingereza.`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(
        `🇬🇧 <b>Language switched to English</b>\n\n` +
          `You will now receive key messages in English.\n\n` +
          `📌 All commands stay the same: /start, /today, /generate, /plan, /analyze\n\n` +
          `Type /lugha again to switch to Swahili.`,
        { parse_mode: "HTML" },
      );
    }
  });
}
