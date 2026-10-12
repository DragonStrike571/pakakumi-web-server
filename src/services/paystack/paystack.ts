import { db } from "../../db/index.js";
import { payments, telegramDeliveries, telegramUsers } from "../../db/schema.js";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { invalidateSessionCache } from "../telegram/bot.js";

const SECRET = process.env.PAYSTACK_SECRET_KEY || "";
const BASE_URL = "https://api.paystack.co";
interface TransactionData { amount: number; status: string; reference: string; currency: string }

async function paystackRequest(path: string, body?: unknown) {
  if (!SECRET) throw new Error("PAYSTACK_SECRET_KEY is not set");
  const response = await fetch(`${BASE_URL}${path}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Paystack request failed (${response.status})`);
  const data = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid Paystack response");
  return data;
}

export async function initializePayment(email: string, amountKES: number, chatId: string, durationPaidFor: number, callbackUrl: string) {
  if (!Number.isFinite(amountKES) || amountKES <= 0 || !Number.isFinite(durationPaidFor) || durationPaidFor <= 0) throw new Error("Invalid payment parameters");
  const data = await paystackRequest("/transaction/initialize", { email, amount: Math.round(amountKES * 100), currency: "KES",
    callback_url: callbackUrl, metadata: { chatId, durationPaidFor } });
  if (data.status) await db.insert(payments).values({ reference: data.data.reference, chatId, amount: amountKES, durationPaidFor,
    status: "pending", nextVerificationAt: new Date(Date.now() + 2 * 60_000) });
  return data;
}

export function verifyPayment(reference: string) { return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`); }

export async function handleSuccessfulPayment(reference: string, data: TransactionData, database: typeof db = db): Promise<boolean> {
  if (data.status !== "success" || data.reference !== reference || data.currency !== "KES" || !Number.isSafeInteger(data.amount) || data.amount <= 0) {
    throw new Error("Paystack response does not match the payment being fulfilled");
  }
  const fulfilled = await database.transaction(async tx => {
    const [payment] = await tx.select().from(payments).where(eq(payments.reference, reference)).limit(1).for("update");
    if (!payment) return false;
    if (data.amount < payment.amount * 100) return false;
    if (payment.status === "success") return true;
    const [user] = await tx.select().from(telegramUsers).where(eq(telegramUsers.chatId, payment.chatId)).limit(1).for("update");
    if (!user) throw new Error("Payment owner no longer exists");
    const duration = Number(payment.durationPaidFor);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Stored payment duration is invalid");
    const expiry = new Date(Math.max(user.expiryTimestamp?.getTime() || 0, Date.now()) + duration * 86_400_000);
    await tx.update(telegramUsers).set({ expiryTimestamp: expiry, revokedAt: null }).where(eq(telegramUsers.chatId, user.chatId));
    // A verified success is authoritative even after local abandonment/timeout.
    await tx.update(payments).set({ status: "success" }).where(eq(payments.id, payment.id));
    await tx.insert(telegramDeliveries).values({ chatId: user.chatId, kind: "invite", dedupeKey: `payment:${reference}` }).onConflictDoNothing();
    invalidateSessionCache(user.chatId);
    return true;
  });
  return fulfilled;
}

export function startPaystackPolling() {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    running = (async () => {
      const candidates = await db.select().from(payments).where(and(
        inArray(payments.status, ["pending", "expired", "failed"]),
        gte(payments.createdAt, new Date(Date.now() - 7 * 86_400_000)), lte(payments.nextVerificationAt, new Date()),
      )).orderBy(payments.nextVerificationAt).limit(100);
      for (const payment of candidates) {
        if (stopped) break;
        const age = Date.now() - payment.createdAt.getTime();
        // Schedule before requesting so one failing transaction cannot starve the batch.
        await db.update(payments).set({ nextVerificationAt: new Date(Date.now() + (age > 30 * 60_000 ? 15 * 60_000 : 30_000)) }).where(eq(payments.id, payment.id));
        try {
          const response = await verifyPayment(payment.reference);
          if (response.status && response.data?.status === "success") await handleSuccessfulPayment(payment.reference, response.data);
          else if (age > 30 * 60_000) await db.update(payments).set({ status: "expired" })
            .where(and(eq(payments.id, payment.id), inArray(payments.status, ["pending", "failed"])));
        } catch (error) { console.error(`Paystack verification will retry (${payment.reference}):`, error); }
      }
    })().catch(error => console.error("Paystack polling failed:", error)).finally(() => {
      if (!stopped) timer = setTimeout(tick, 30_000);
    });
  };
  timer = setTimeout(tick, 1000);
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
