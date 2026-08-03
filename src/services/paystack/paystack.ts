import { db } from "../../db/index.js";
import { payments, telegramUsers } from "../../db/schema.js";
import { eq, and, gte, lt } from "drizzle-orm";
import { bot } from "../telegram/bot.js";
import {
  rateLimitedSend,
  rateLimitedCreateInviteLink,
} from "../telegram/rate-limiter.js";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYSTACK_TIMEOUT_MS = 15_000;

interface PaystackTransactionData {
  amount: number;
  status: string;
  reference: string;
  metadata?: {
    chatId?: string;
    durationPaidFor?: number;
  };
}

/**
 * 1. Initialize the payment and lock the parameters in the local database.
 */
export async function initializePayment(
  email: string,
  amountKES: number,
  chatId: string,
  durationPaidFor: number,
  callbackUrl: string,
) {
  if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set");

  const amountInCents = Math.round(amountKES * 100);

  const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: amountInCents,
      currency: "KES",
      callback_url: callbackUrl,
      metadata: { chatId, durationPaidFor },
    }),
    signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Paystack initialization failed (${response.status})`);

  if (data.status) {
    await db.insert(payments).values({
      reference: data.data.reference,
      chatId,
      amount: amountKES,
      durationPaidFor,
      status: "pending",
    });
  }

  return data;
}

/**
 * 2. Fetch the transaction status directly from Paystack.
 */
export async function verifyPayment(reference: string) {
  if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set");

  const response = await fetch(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
    },
  );

  const data = await response.json();
  if (!response.ok) throw new Error(`Paystack verification failed (${response.status})`);

  if (!data || typeof data !== "object") {
    throw new Error(`Paystack verify returned invalid data for ${reference}`);
  }

  return data;
}

/**
 * 3. Fulfill the order, enforce math security, and grant access.
 */
export async function handleSuccessfulPayment(
  reference: string,
  paystackData: PaystackTransactionData,
) {
  if (
    paystackData.status !== "success" ||
    paystackData.reference !== reference ||
    !Number.isFinite(paystackData.amount)
  ) {
    throw new Error("Paystack response does not match the payment being fulfilled");
  }

  const fulfillment = await db.transaction(async (tx) => {
    const [paymentRecord] = await tx
      .select()
      .from(payments)
      .where(eq(payments.reference, reference))
      .limit(1);
    if (!paymentRecord || paymentRecord.status === "success") return null;
    if (paymentRecord.status !== "pending") return null;

    const expectedAmount = Number(paymentRecord.amount);
    const actualPaidKES = paystackData.amount / 100;
    if (!Number.isFinite(expectedAmount) || actualPaidKES < expectedAmount) {
      console.error(
        `🚨 Underpayment detected for ${reference}. Expected ${expectedAmount}, got ${actualPaidKES}`,
      );
      await tx
        .update(payments)
        .set({ status: "failed" })
        .where(and(
          eq(payments.reference, reference),
          eq(payments.status, "pending"),
        ));
      return null;
    }

    // Claim the pending payment. A concurrent callback/poller can no longer
    // fulfill the same payment after this conditional update succeeds.
    const [claimed] = await tx
      .update(payments)
      .set({ status: "success" })
      .where(and(
        eq(payments.reference, reference),
        eq(payments.status, "pending"),
      ))
      .returning({ chatId: payments.chatId });
    if (!claimed) return null;

    const [user] = await tx
      .select()
      .from(telegramUsers)
      .where(eq(telegramUsers.chatId, claimed.chatId))
      .limit(1);
    if (!user) throw new Error("Payment owner no longer exists");

    const duration = Number(paymentRecord.durationPaidFor);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Stored payment duration is invalid");
    }
    const now = new Date();
    const currentExpiry =
      user.expiryTimestamp && user.expiryTimestamp > now
        ? user.expiryTimestamp
        : now;
    const newExpiry = new Date(
      currentExpiry.getTime() + duration * 24 * 60 * 60 * 1000,
    );

    await tx
      .update(telegramUsers)
      .set({ expiryTimestamp: newExpiry })
      .where(eq(telegramUsers.chatId, claimed.chatId));
    return { chatId: claimed.chatId, newExpiry };
  });

  if (fulfillment && bot) {
      const { chatId, newExpiry } = fulfillment;
      const privateChannelId = process.env.PRIVATE_CHANNEL_ID;
      if (privateChannelId) {
        try {
          const invite = await rateLimitedCreateInviteLink(
            privateChannelId,
            {
              member_limit: 1,
              expire_date: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
            },
            "high",
          );

          await rateLimitedSend(
            chatId,
            `🎉 <b>Payment Verified!</b>\n\nYour Premium Access has been secured until <b>${newExpiry.toDateString()}</b>.\n\nJoin the Premium Room here (Link expires after 1 use):\n${invite.invite_link}`,
            { parse_mode: "HTML" },
            "high",
          );
        } catch (err) {
          console.error("Failed to generate/send invite link:", err);
        }
      }
  }
}

/**
 * 4. The web-hook free background polling loop.
 *
 * IMPORTANT: Paystack marks transactions as "abandoned" almost immediately
 * after initialization if the user hasn't visited the checkout page yet.
 * This does NOT mean the user cancelled — it simply means they haven't
 * completed the payment flow. We must give users a generous grace period
 * before treating "abandoned" as a terminal state.
 */
export function startPaystackPolling() {
  const POLLING_INTERVAL = 30 * 1000; // 30 seconds between poll cycles
  const FRESH_PAYMENT_GRACE_MS = 2 * 60 * 1000; // Skip payments younger than 2 minutes
  const ABANDONED_GRACE_MS = 30 * 60 * 1000; // Only fail "abandoned" after 30 minutes
  const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000; // Auto-expire after 24 hours
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const runPoller = async () => {
    try {
      const pendingPayments = await db
        .select()
        .from(payments)
        .where(eq(payments.status, "pending"));

      if (pendingPayments.length > 0) {
        console.log(
          `[Paystack Poller] Checking ${pendingPayments.length} pending payment(s)`,
        );
      }

      for (const payment of pendingPayments) {
        try {
          const paymentAge = Date.now() - new Date(payment.createdAt).getTime();

          // Skip very fresh payments — give the user time to reach the checkout page
          if (paymentAge < FRESH_PAYMENT_GRACE_MS) {
            console.log(
              `[Paystack Poller] Skipping ${payment.reference} — only ${Math.round(paymentAge / 1000)}s old`,
            );
            continue;
          }

          // Auto-expire extremely stale payments without even calling Paystack
          if (paymentAge > MAX_PENDING_AGE_MS) {
            console.log(
              `[Paystack Poller] Expiring ${payment.reference} — over 24h old`,
            );
            await db
              .update(payments)
              .set({ status: "failed" })
              .where(eq(payments.reference, payment.reference));
            continue;
          }

          const data = await verifyPayment(payment.reference);

          // Log the raw Paystack response for debugging
          const paystackStatus = data?.data?.status;
          console.log(
            `[Paystack Poller] ${payment.reference} → Paystack status: "${paystackStatus}" (age: ${Math.round(paymentAge / 1000)}s)`,
          );

          if (!data || !data.status || !data.data) {
            // Paystack API call itself failed or returned unexpected shape.
            // Do NOT mark the payment as failed — just skip and retry next cycle.
            console.warn(
              `[Paystack Poller] Unexpected response for ${payment.reference}:`,
              JSON.stringify(data).slice(0, 300),
            );
            continue;
          }

          if (paystackStatus === "success") {
            console.log(
              `[Paystack Poller] ✅ Payment ${payment.reference} succeeded!`,
            );
            await handleSuccessfulPayment(payment.reference, data.data);
          } else if (paystackStatus === "failed") {
            // "failed" is a hard terminal state from Paystack (card declined, etc.)
            console.log(
              `[Paystack Poller] ❌ Payment ${payment.reference} definitively failed`,
            );
            await markPaymentFailed(payment);
          } else if (paystackStatus === "abandoned") {
            // "abandoned" is NOT immediately terminal. Paystack sets this when
            // the user hasn't completed checkout yet — they may still come back.
            // Only mark as failed after the grace period.
            if (paymentAge > ABANDONED_GRACE_MS) {
              console.log(
                `[Paystack Poller] ❌ Payment ${payment.reference} abandoned for ${Math.round(paymentAge / 60000)}min — marking failed`,
              );
              await markPaymentFailed(payment);
            } else {
              console.log(
                `[Paystack Poller] ⏳ Payment ${payment.reference} shows "abandoned" but only ${Math.round(paymentAge / 60000)}min old — waiting`,
              );
            }
          }
          // For any other status ("pending", "ongoing", etc.), do nothing.
          // The payment stays "pending" in our DB and will be rechecked next cycle.

          // THROTTLE: 200ms delay between Paystack API calls to prevent rate limiting
          await new Promise((res) => setTimeout(res, 200));
        } catch (err) {
          // Network error, timeout, etc. — do NOT mark the payment as failed.
          console.error(
            `[Paystack Poller] Error checking ${payment.reference}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error("[Paystack Poller] Fatal error in polling loop:", err);
    } finally {
      if (!stopped) timer = setTimeout(runPoller, POLLING_INTERVAL);
    }
  };

  // Start the first poll cycle
  console.log("[Paystack Poller] Started — polling every 30s");
  timer = setTimeout(runPoller, POLLING_INTERVAL);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Helper: mark a payment as failed and notify the user via Telegram.
 */
async function markPaymentFailed(payment: { reference: string; chatId: string }) {
  await db
    .update(payments)
    .set({ status: "failed" })
    .where(eq(payments.reference, payment.reference));

  if (bot) {
    await rateLimitedSend(
      payment.chatId,
      "❌ <b>Payment Failed or Cancelled</b>\n\nThe request timed out, lacked funds, or was cancelled. Generate a new link to try again.",
      { parse_mode: "HTML" },
      "normal",
    ).catch(console.error);
  }
}
