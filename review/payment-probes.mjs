// Exercise the actual payment handler with isolated, in-memory DB/API fixtures.
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/review";
process.env.TELEGRAM_BOT_TOKEN = "999:offline-test";
process.env.PRIVATE_CHANNEL_ID = "-100999";
globalThis.fetch = async () => { throw new Error("Network disabled in payment review probes"); };
const { db, pool } = await import("../src/db/index.ts");
pool.query = async () => { throw new Error("Real database disabled in payment probes"); };
pool.connect = async () => { throw new Error("Real database disabled in payment probes"); };
const tables = await import("../src/db/schema.ts");
const { handleSuccessfulPayment } = await import("../src/services/paystack/paystack.ts");
const { bot } = await import("../src/services/telegram/bot.ts");
let apiCalls = 0;
bot.api.config.use(async () => { apiCalls++; throw new Error("synthetic invite delivery failure"); });
const originalError = console.error;
console.error = () => undefined;

let payments = [];
let expiry;
let transactionIndex = 0;
let synchronizeUsers = false;
let userReads = 0;
let releaseUserReads;
let userReadBarrier;
const fixture = (reference, status = "pending") => ({ reference, status, chatId: "123", amount: 350, durationPaidFor: 1 });
const verified = (reference) => ({ reference, status: "success", amount: 35000 });

db.transaction = async (work) => {
  const payment = payments[transactionIndex++ % payments.length];
  return work({
    select: () => {
      let table;
      const builder = {
        from: (value) => { table = value; return builder; },
        where: () => builder,
        limit: async () => {
          if (table === tables.payments) return [payment];
          const snapshot = { expiryTimestamp: new Date(expiry) };
          if (synchronizeUsers) {
            userReads++;
            if (userReads === 2) releaseUserReads();
            await userReadBarrier;
          }
          return [snapshot];
        },
      };
      return builder;
    },
    update: (table) => {
      let value;
      const builder = {
        set: (data) => { value = data; return builder; },
        where: () => builder,
        returning: async () => { payment.status = value.status; return [{ chatId: payment.chatId }]; },
        then: (resolve, reject) => {
          if (table === tables.telegramUsers) expiry = value.expiryTimestamp;
          if (table === tables.payments) payment.status = value.status;
          return Promise.resolve([]).then(resolve, reject);
        },
      };
      return builder;
    },
  });
};

payments = [fixture("delivery")];
expiry = new Date(Date.now() + 2 * 86400000);
await handleSuccessfulPayment("delivery", verified("delivery"));
await handleSuccessfulPayment("delivery", verified("delivery"));
assert.equal(payments[0].status, "success");
assert.equal(apiCalls, 1);
console.log(JSON.stringify({ probe: "invite_delivery_not_retried", paymentStatus: payments[0].status, fulfillmentAttempts: 2, inviteAttempts: apiCalls }));

payments = [fixture("late", "failed")];
const beforeLate = expiry.getTime();
await handleSuccessfulPayment("late", verified("late"));
assert.equal(payments[0].status, "failed");
assert.equal(expiry.getTime(), beforeLate);
console.log(JSON.stringify({ probe: "late_verified_success_ignored", verifiedStatus: "success", localStatus: payments[0].status, accessExtended: false }));

payments = [fixture("concurrent-a"), fixture("concurrent-b")];
transactionIndex = 0;
const initialExpiry = new Date(Date.now() + 2 * 86400000);
expiry = initialExpiry;
synchronizeUsers = true;
userReadBarrier = new Promise((resolve) => { releaseUserReads = resolve; });
await Promise.all([
  handleSuccessfulPayment("concurrent-a", verified("concurrent-a")),
  handleSuccessfulPayment("concurrent-b", verified("concurrent-b")),
]);
const creditedDays = (expiry.getTime() - initialExpiry.getTime()) / 86400000;
assert.equal(creditedDays, 1);
assert.deepEqual(payments.map((payment) => payment.status), ["success", "success"]);
console.log(JSON.stringify({ probe: "concurrent_renewal", purchasedDays: 2, creditedDays, successfulPayments: 2 }));
console.error = originalError;
console.log("Offline payment probes completed; all assertions passed. No messages sent.");
process.exit(0);
