import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { Api } from "grammy";
import { migrateDatabase } from "../db/migrations.js";
import * as schema from "../db/schema.js";

process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/test";
process.env.TELEGRAM_BOT_TOKEN = "123456:offline-regression-token";
process.env.ADMIN_CHANNEL_ID = "-100000001";
globalThis.fetch = async () => { throw new Error("Network disabled in regression tests"); };
const { db, pool } = await import("../db/index.js");
pool.query = (async () => { throw new Error("Production database disabled in tests"); }) as typeof pool.query;
pool.connect = (async () => { throw new Error("Production database disabled in tests"); }) as typeof pool.connect;
const { handleSuccessfulPayment } = await import("./paystack/paystack.js");
const { dispatchDeliveries, requestPremiumInvite } = await import("./telegram/outbox.js");
const { expireSubscriptions } = await import("./telegram/expiry.js");
const { RoundService } = await import("./round.js");

async function fixture() {
  const pg = new PGlite(); await pg.exec("SET TIME ZONE 'UTC'"); await migrateDatabase(pg);
  return { pg, database: drizzle(pg, { schema }) as unknown as typeof db };
}

test("idle pool errors are contained without an uncaught EventEmitter error", () => {
  assert.ok(pool.listenerCount("error") > 0);
  assert.doesNotThrow(() => pool.emit("error", new Error("synthetic idle failure")));
});

test("invite recovery unbans only banned users and never removes an existing member", async () => {
  const { bot } = await import("./telegram/bot.js");
  const { rateLimitedUnban } = await import("./telegram/rate-limiter.js");
  let payload: any;
  bot!.api.config.use(async (_previous, method, request) => {
    assert.equal(method, "unbanChatMember"); payload = request;
    return { ok: true, result: true } as any;
  });
  await rateLimitedUnban("-100000001", 101);
  assert.equal(payload.only_if_banned, true);
});

test("concurrent renewals add both durations; duplicate and late verified payments are idempotent", async () => {
  const { pg, database } = await fixture();
  try {
    const original = new Date(Date.now() + 86_400_000);
    await database.insert(schema.telegramUsers).values({ chatId: "1", expiryTimestamp: original });
    await database.insert(schema.payments).values(["a", "b"].map(reference => ({ reference, chatId: "1", amount: 50, durationPaidFor: 1, status: reference === "a" ? "failed" : "pending" })));
    const verified = (reference: string) => ({ reference, status: "success", amount: 5000, currency: "KES" });
    assert.deepEqual(await Promise.all([handleSuccessfulPayment("a", verified("a"), database), handleSuccessfulPayment("b", verified("b"), database)]), [true, true]);
    await handleSuccessfulPayment("a", verified("a"), database);
    const user = await database.query.telegramUsers.findFirst();
    assert.equal(user!.expiryTimestamp!.getTime(), original.getTime() + 2 * 86_400_000);
    assert.equal((await database.select().from(schema.telegramDeliveries)).length, 2);
    await assert.rejects(handleSuccessfulPayment("a", { ...verified("a"), currency: "USD" }, database));
    assert.equal(await handleSuccessfulPayment("missing", verified("missing"), database), false);
  } finally { await pg.close(); }
});

test("failed invite delivery remains retryable and status can queue a fresh invite", async () => {
  const { pg, database } = await fixture();
  try {
    await database.insert(schema.telegramUsers).values({ chatId: "1", expiryTimestamp: new Date(Date.now() + 86_400_000) });
    await database.insert(schema.telegramDeliveries).values({ chatId: "1", kind: "invite", dedupeKey: "test" });
    let attempts = 0;
    const transport: any = { unban: async () => true, createInvite: async () => ({ invite_link: "https://t.me/test?x=1&y=2" }), send: async () => {
      attempts++; if (attempts === 1) throw new Error("Telegram unavailable"); return {};
    } };
    await dispatchDeliveries(database, transport, "channel");
    let [job] = await database.select().from(schema.telegramDeliveries);
    assert.equal(job!.status, "pending"); assert.equal(job!.attempts, 1);
    await database.update(schema.telegramDeliveries).set({ nextAttemptAt: new Date(0) });
    await dispatchDeliveries(database, transport, "channel");
    [job] = await database.select().from(schema.telegramDeliveries);
    assert.equal(job!.status, "sent"); assert.equal(attempts, 2);
    assert.equal(await requestPremiumInvite("1", database), true);
    assert.equal((await database.select().from(schema.telegramDeliveries)).length, 2);
  } finally { await pg.close(); }
});

test("expiry visits every batch, preserves admins and renewals, and does not repeat removal", async () => {
  const { pg, database } = await fixture();
  try {
    await database.insert(schema.telegramUsers).values(Array.from({ length: 45 }, (_, i) => ({ chatId: String(i + 1).padStart(3, "0"), expiryTimestamp: new Date(Date.now() - 60_000) })));
    const banned: number[] = [];
    let renewed = false;
    const api = { getChatMember: async (_channel: string, id: number) => {
      if (id === 1) return { status: "administrator" };
      if (id === 2) throw new Error("permission failure");
      // A later user renewed after the batch SELECT but before its locked recheck.
      if (!renewed) {
        renewed = true;
        // Executed in the current transaction connection to model the already committed update.
      }
      return { status: "member" };
    }, banChatMember: async (_channel: string, id: number) => { banned.push(id); }, unbanChatMember: async () => true } as unknown as Api;
    const transaction = database.transaction.bind(database);
    let first = true;
    database.transaction = (async (callback: any) => {
      if (first) { first = false; await database.update(schema.telegramUsers).set({ expiryTimestamp: new Date(Date.now() + 86_400_000) }).where(eq(schema.telegramUsers.chatId, "003")); }
      return transaction(callback);
    }) as typeof database.transaction;
    await expireSubscriptions(() => false, database, api, "channel");
    assert.equal(banned.length, 42); assert.ok(banned.includes(45)); assert.ok(!banned.includes(1) && !banned.includes(2) && !banned.includes(3));
    await expireSubscriptions(() => false, database, api, "channel");
    assert.equal(banned.length, 42);
    assert.equal((await database.select().from(schema.telegramDeliveries)).length, 42);
  } finally { await pg.close(); }
});

test("round retry cannot insert twice or mutate counters before a successful insert", async () => {
  const { pg, database } = await fixture();
  try {
    const round = { ingestionId: randomUUID(), bust: 3000, bustId: "3000-2-3-4-5-6-7-8-9-10", metricsComplete: false,
      playersOnline: null, playersPlaying: null, totalAmountPlayed: null, totalAmountWon: null, totalAmountLost: null, averageAmountPlayed: null, maxAmountPlayed: null };
    const service = new RoundService(database);
    await service.processRound(round); await service.processRound(round);
    assert.equal((await database.select().from(schema.rounds)).length, 1);
    const before = service.getState();
    const insert = database.insert.bind(database);
    database.insert = (() => { throw new Error("temporary insert failure"); }) as typeof database.insert;
    await assert.rejects(service.processRound({ ...round, ingestionId: randomUUID(), bust: 1.01, bustId: "missing" }));
    assert.deepEqual(service.getState(), before);
    database.insert = insert;
    await service.processRound({ ...round, ingestionId: randomUUID(), bust: 1.01, bustId: "1.01-3000-2-3-4-5-6-7-8-9" });
    assert.equal(service.getState().roundsSinceLast3000, 1);
  } finally { await pg.close(); }
});

test("opening and closing support immediately refreshes the actual Telegram session cache", async () => {
  const { pg, database } = await fixture();
  try {
    for (const method of ["select", "insert", "update", "delete", "transaction"] as const) (db as any)[method] = database[method].bind(database);
    (db as any).query = database.query;
    const { syncTelegramSession, setSessionState } = await import("./telegram/bot.js");
    const context = (): any => ({ chat: { id: 101 }, from: { id: 101, first_name: "Test" }, dbState: "command" });
    const first = context();
    await syncTelegramSession(first, async () => setSessionState(first, "support"));
    const second = context();
    await syncTelegramSession(second, async () => undefined);
    assert.equal(second.dbState, "support");
    await setSessionState(second, "command");
    const third = context();
    await syncTelegramSession(third, async () => undefined);
    assert.equal(third.dbState, "command");
  } finally { await pg.close(); }
});

test("support handler escapes literal user text and reports failed delivery accurately", async () => {
  const { pg, database } = await fixture();
  try {
    for (const method of ["select", "insert", "update", "delete", "transaction"] as const) (db as any)[method] = database[method].bind(database);
    (db as any).query = database.query;
    await database.insert(schema.telegramUsers).values({ chatId: "101" });
    const { setupMessages } = await import("./telegram/handlers/messages.js");
    let handler: any;
    const fakeBot: any = { on: (_filter: unknown, callback: unknown) => { handler = callback; } };
    const replies: string[] = [], forwarded: string[] = [];
    setupMessages(fakeBot, (async (_chat: string, text: string) => { forwarded.push(text); throw new Error("delivery failed"); }) as any);
    await handler({ chat: { id: 101 }, from: { id: 101, username: "<name>" }, message: { text: "<example> & value" },
      dbState: "support", reply: async (text: string) => { replies.push(text); } });
    assert.match(forwarded[0]!, /&lt;name&gt;/); assert.match(forwarded[0]!, /&lt;example&gt; &amp; value/);
    assert.equal(replies.length, 1); assert.match(replies[0]!, /delivery to support failed/);
    assert.equal((await database.select().from(schema.supportTickets))[0]!.message, "<example> & value");
  } finally { await pg.close(); }
});

test("analysis cold start excludes future recovery rows, serializes hits and flushes daily statistics", async () => {
  const { pg, database } = await fixture();
  try {
    for (const method of ["select", "insert", "update", "delete", "transaction"] as const) (db as any)[method] = database[method].bind(database);
    (db as any).query = database.query;
    const time = Date.now() - 1000;
    const rows = [1.01, 3000, 1.01].map((bust, i) => ({ id: randomUUID(), bust, bustId: `fixture-${i}`, createdAt: new Date(time + i) }));
    await database.insert(schema.rounds).values(rows);
    await database.insert(schema.systemStats).values({ id: 1, signals: 1, hits: 0, lastAlertRound: 0 });
    await database.insert(schema.pendingSignals).values({ id: "3000", target: 3000, confidence: 90, maxLifespan: 20 });
    await database.insert(schema.signalHistory).values({ target: 3000, confidence: 90 });
    const engine = await import("./analysis/engine.js");
    const cold = await engine.runAnalysisEngine(rows[0]!);
    assert.equal(cold.stats.roundsAnalyzed, 1);
    const results = await Promise.all([engine.runAnalysisEngine(rows[1]!), engine.runAnalysisEngine(rows[2]!)]);
    assert.equal(results[1]!.stats.roundsAnalyzed, 3);
    assert.equal(results[1]!.stats.totalHits, 1); assert.ok(results[1]!.stats.accuracy <= 100);
    assert.equal((await database.select().from(schema.signalHistory).where(eq(schema.signalHistory.target, 3000)))[0]!.actualRoundsToHit, 2);
    await engine.runAnalysisEngine(rows[2]!);
    const fourth = { id: randomUUID(), bust: 1.01, bustId: "fourth", createdAt: new Date(time + 3) };
    await database.insert(schema.rounds).values(fourth);
    const transaction = database.transaction.bind(database);
    let fail = true;
    (db as any).transaction = (callback: any) => transaction(async tx => {
      const result = await callback(tx);
      if (fail) { fail = false; throw new Error("synthetic transaction rollback"); }
      return result;
    });
    await assert.rejects(engine.runAnalysisEngine(fourth), /synthetic transaction rollback/);
    const retry = await engine.runAnalysisEngine(fourth);
    assert.equal(retry.stats.roundsAnalyzed, 4);
    const restarted = await import(new URL(`./analysis/engine.${import.meta.url.endsWith(".ts") ? "ts" : "js"}?restart`, import.meta.url).href);
    const replay = await restarted.runAnalysisEngine(fourth);
    assert.equal(replay.replayed, true); assert.equal(replay.stats.totalHits, 1);
    await engine.drainAnalysis();
    assert.equal((await database.select().from(schema.systemStats))[0]!.hits, 1);
    assert.equal((await database.select().from(schema.dailyStats))[0]!.totalHits, 1);
  } finally { await pg.close(); }
});
