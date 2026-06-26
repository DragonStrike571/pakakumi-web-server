import { db } from "../../db/index.js";
import { payments, telegramUsers } from "../../db/schema.js";
import { eq, and, gte } from "drizzle-orm";
import { bot } from "../telegram/bot.js";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PAYSTACK_BASE_URL = "https://api.paystack.co";

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

  // Paystack expects the lowest denomination (cents/kobo)
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
  });

  const data = await response.json();

  if (data.status) {
    // SECURITY: Lock the expected amount and duration in our database.
    await db.insert(payments).values({
      reference: data.data.reference,
      chatId,
      amount: amountKES, // Storing flat KES amount for easy cross-referencing
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
    },
  );

  const data = await response.json();

  // Guard against malformed responses
  if (!data || typeof data !== 'object') {
    throw new Error(`Paystack verify returned invalid data for ${reference}`);
  }

  return data;
}

/**
 * 3. The web-hook free background polling loop.
 */
export function startPaystackPolling() {
  const POLLING_INTERVAL = 15 * 1000; // 15 seconds

  const runPoller = async () => {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      const pendingPayments = await db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.status, "pending"),
            gte(payments.createdAt, oneHourAgo),
          ),
        );

      for (const payment of pendingPayments) {
        try {
          const paymentTime = new Date(payment.createdAt).getTime();
          const ageMinutes = (Date.now() - paymentTime) / 60000;

          // Timezone / STK Push Grace Period Fix
          if (ageMinutes < 0.5) continue;

          if (ageMinutes > 15) {
            await db
              .update(payments)
              .set({ status: "failed" })
              .where(eq(payments.reference, payment.reference));
            continue;
          }

          const data = await verifyPayment(payment.reference);

          if (data.status && data.data) {
            const paystackStatus = data.data.status;

            if (paystackStatus === "success") {
              await handleSuccessfulPayment(payment.reference, data.data);
            } else if (
              paystackStatus === "failed" ||
              paystackStatus === "abandoned"
            ) {
              await db
                .update(payments)
                .set({ status: "failed" })
                .where(eq(payments.reference, payment.reference));

              if (bot) {
                await bot.api
                  .sendMessage(
                    payment.chatId,
                    "❌ **Payment Failed or Cancelled**\n\nThe M-Pesa request timed out, lacked funds, or was cancelled. If you still want Premium, please generate a new link.",
                    { parse_mode: "Markdown" },
                  )
                  .catch(console.error);
              }
            }
          }
          await new Promise((res) => setTimeout(res, 200));
        } catch (err) {
          console.error(`Error polling payment ${payment.reference}:`, err);
        }
      }
    } catch (err) {
      console.error("Error in paystack polling loop:", err);
    } finally {
      setTimeout(runPoller, POLLING_INTERVAL);
    }
  };

  setTimeout(runPoller, POLLING_INTERVAL);
}

/**
 * Shape of Paystack transaction data after verification.
 */
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
 * 4. Fulfill the order, enforce math security, and grant access.
 */
export async function handleSuccessfulPayment(
  reference: string,
  paystackData: PaystackTransactionData,
) {
  // Fetch the local invoice truth
  const paymentRecord = await db
    .select()
    .from(payments)
    .where(eq(payments.reference, reference))
    .then((res) => res[0]);

  if (!paymentRecord || paymentRecord.status === "success") return;

  // SECURITY CHECK: Did they pay the full amount?
  // Paystack returns amount in cents. Divide by 100 to get KES.
  const actualPaidKES = paystackData.amount / 100;
  if (actualPaidKES < paymentRecord.amount) {
    console.error(
      `🚨 Underpayment detected for ${reference}. Expected ${paymentRecord.amount}, got ${actualPaidKES}`,
    );
    await db
      .update(payments)
      .set({ status: "failed" })
      .where(eq(payments.reference, reference));
    return;
  }

  // Update invoice to success
  await db
    .update(payments)
    .set({ status: "success" })
    .where(eq(payments.reference, reference));

  const chatId = paymentRecord.chatId;
  const duration = paymentRecord.durationPaidFor;

  const user = await db
    .select()
    .from(telegramUsers)
    .where(eq(telegramUsers.chatId, chatId))
    .then((res) => res[0]);

  if (user) {
    const now = new Date();
    // If active, add to existing expiry. If expired/null, add to NOW.
    const currentExpiry =
      user.expiryTimestamp && user.expiryTimestamp > now
        ? user.expiryTimestamp
        : now;
    const newExpiry = new Date(
      currentExpiry.getTime() + duration * 24 * 60 * 60 * 1000,
    );

    await db
      .update(telegramUsers)
      .set({ expiryTimestamp: newExpiry })
      .where(eq(telegramUsers.chatId, chatId));

    // Dispatch the invite link via Bot API
    if (bot) {
      const privateChannelId = process.env.PRIVATE_CHANNEL_ID;
      if (privateChannelId) {
        try {
          const invite = await bot.api.createChatInviteLink(privateChannelId, {
            member_limit: 1, // Single-use prevents link sharing
            expire_date: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // Must click within 24 hours
          });

          await bot.api.sendMessage(
            chatId,
            `🎉 **Payment Verified!**\n\nYour Premium Access has been secured until *${newExpiry.toDateString()}*.\n\nJoin the Premium Room here (Link expires after 1 use):\n${invite.invite_link}`,
            { parse_mode: "Markdown" },
          );
        } catch (err) {
          console.error("Failed to generate/send invite link:", err);
        }
      }
    }
  }
}
