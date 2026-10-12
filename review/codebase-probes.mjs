// Offline review probes. No production database, browser, or Telegram calls.
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.PRIVATE_CHANNEL_ID = "";
process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/review";
process.env.BETTER_AUTH_SECRET = "offline-review-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
globalThis.fetch = async () => { throw new Error("Network disabled in review probes"); };

const { db, pool } = await import("../src/db/index.ts");
pool.query = async () => { throw new Error("Real database disabled in review probes"); };
pool.connect = async () => { throw new Error("Real database disabled in review probes"); };
const { auth } = await import("../src/lib/auth.ts");
const { parseUserInput } = await import("better-auth/db");
for (const action of ["create", "update"]) {
  const accepted = parseUserInput(auth.options, { role: "admin", accessStatus: "active" }, action);
  assert.equal(accepted.role, "admin");
  assert.equal(accepted.accessStatus, "active");
  console.log(JSON.stringify({ probe: "client_privileges", action, accepted }));
}

assert.equal(pool.listenerCount("error"), 0);
assert.throws(() => pool.emit("error", new Error("synthetic idle connection failure")));
console.log(JSON.stringify({ probe: "pool_idle_error", caughtByPool: false }));

const { GameScraper } = await import("../src/services/scraper.ts");
const data = {
  busts: Array.from({ length: 40 }, (_, i) => 1.1 + i / 10),
  onlineCount: 10, playingCount: 7,
  totalCashPlayed: 70, totalWinAmount: 20, totalLossAmount: 50,
  averageSpending: 10, maxSpending: 10,
};
const scraper = new GameScraper();
scraper.page = {};
scraper.scrapeGameData = async () => data;
for (let i = 1; i < 30; i++) scraper.previousBustIDs.add(scraper.generateBustID(data.busts, i));
let saveAttempts = 0;
scraper.on("roundEnded", () => { saveAttempts++; /* Simulate an unsuccessful persistence attempt. */ });
await scraper.checkForChanges();
await scraper.checkForChanges();
assert.equal(saveAttempts, 1);
console.log(JSON.stringify({ probe: "failed_save_no_retry", scrapes: 2, saveAttempts }));

const fresh = new GameScraper();
fresh.page = {};
fresh.scrapeGameData = async () => data;
let recovered = 0;
fresh.on("roundEnded", () => recovered++);
await fresh.initialScrape();
await fresh.checkForChanges();
assert.equal(recovered, 0);
console.log(JSON.stringify({ probe: "cold_start_history", visibleRounds: 40, recovered }));

const incomplete = new GameScraper();
incomplete.page = {
  locator: (selector) => ({
    allInnerTexts: async () => selector.includes("td span") ? ["1.41x", "1.34x"] : [],
    innerText: async () => selector.includes("[1]") ? "10" : "7",
  }),
};
const extracted = await incomplete.scrapeGameData();
incomplete.previousBustIDs.add(incomplete.generateBustID(extracted.busts, 1));
let incompleteRound;
incomplete.on("roundEnded", (round) => { incompleteRound = round; });
await incomplete.checkForChanges();
assert.equal(incompleteRound.metricsComplete, true);
assert.equal(incompleteRound.totalAmountPlayed, 0);
assert.equal(incompleteRound.playersPlaying, 7);
console.log(JSON.stringify({ probe: "empty_metrics", metricsComplete: incompleteRound.metricsComplete, played: incompleteRound.totalAmountPlayed, players: incompleteRound.playersPlaying }));

const schema = await import("../src/db/schema.ts");
let storedPending = [];
let storedStats = { id: 1, hits: 0, signals: 0, lastAlertRound: 0 };
let storedDaily = { date: new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }), totalPredictions: 0, totalHits: 0, totalMisses: 0, targets: [] };
const latest = { bust: 1.2, createdAt: new Date() };
db.query.rounds.findMany = async () => [latest];
db.select = () => {
  let table;
  const chain = {
    from: (value) => { table = value; return chain; },
    where: () => chain,
    then: (resolve, reject) => Promise.resolve(
      table === schema.pendingSignals ? structuredClone(storedPending) :
      table === schema.systemStats ? [{ ...storedStats }] :
      table === schema.dailyStats ? [structuredClone(storedDaily)] : [],
    ).then(resolve, reject),
  };
  return chain;
};
db.update = () => ({ set: () => ({ where: async () => [] }) });
db.insert = () => {
  const chain = { values: () => chain, onConflictDoNothing: async () => [], onConflictDoUpdate: async () => [], then: (resolve, reject) => Promise.resolve([]).then(resolve, reject) };
  return chain;
};
db.delete = () => ({ where: async () => [] });

const coldEngine = await import("../src/services/analysis/engine.ts?review=cold");
const coldResult = await coldEngine.runAnalysisEngine(latest);
assert.equal(coldResult.stats.roundsAnalyzed, 2);
console.log(JSON.stringify({ probe: "analysis_cold_duplicate", persistedRounds: 1, analyzedRounds: coldResult.stats.roundsAnalyzed }));

storedPending = [{ id: "2", target: 2, confidence: 80, roundsElapsed: 0, maxLifespan: 10, cooldownExpiry: 20, reason: "fixture", createdAt: new Date() }];
storedStats = { id: 1, hits: 0, signals: 1, lastAlertRound: 0 };
storedDaily = { ...storedDaily, totalPredictions: 1, targets: [{ target: 2, hit: false, resolved: false, createdAt: new Date().toISOString() }] };
const concurrentEngine = await import("../src/services/analysis/engine.ts?review=concurrent");
await concurrentEngine.runAnalysisEngine();
let deletes = 0;
let release;
const bothDeletes = new Promise((resolve) => { release = resolve; });
db.delete = () => ({ where: async () => {
  deletes++;
  if (deletes === 2) release();
  await bothDeletes;
  return [];
} });
const results = await Promise.all([
  concurrentEngine.runAnalysisEngine({ bust: 3, createdAt: new Date() }),
  concurrentEngine.runAnalysisEngine({ bust: 3, createdAt: new Date() }),
]);
assert.equal(results[0].stats.totalHits, 2);
assert.equal(results[0].stats.totalSignals, 1);
console.log(JSON.stringify({ probe: "analysis_concurrent_hit", oneSignalHits: results[0].stats.totalHits, accuracy: results[0].stats.accuracy }));

const { Bot } = await import("grammy");
const { createSessionStateMiddleware } = await import("../src/services/telegram/session-state.ts");
const { setupCommands } = await import("../src/services/telegram/handlers/commands.ts");
const info = { id: 999, is_bot: true, first_name: "Offline", username: "offline_bot" };
const testBot = new Bot("999:offline-test", { botInfo: info });
testBot.api.config.use(async () => ({ ok: true, result: { message_id: 1, date: 0, chat: { id: 123, type: "private" } } }));
let persistedState = "command";
db.update = () => ({ set: (value) => ({ where: async () => { persistedState = value.sessionState; return []; } }) });
testBot.use(createSessionStateMiddleware(async () => persistedState).middleware);
setupCommands(testBot);
let nextState;
testBot.on("message:text", (ctx) => { nextState = ctx.dbState; });
const user = { id: 123, is_bot: false, first_name: "Test" };
const chat = { id: 123, type: "private", first_name: "Test" };
await testBot.handleUpdate({ update_id: 1, callback_query: { id: "1", from: user, chat_instance: "offline", data: "menu_support", message: { message_id: 1, date: 0, chat, text: "menu" } } });
await testBot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 0, chat, from: user, text: "help please" } });
assert.equal(persistedState, "support");
assert.equal(nextState, "command");
console.log(JSON.stringify({ probe: "support_cache", databaseState: persistedState, nextMessageState: nextState }));

const { chromium } = await import("playwright");
const { balancePool } = await import("../src/services/balance-pool.ts");
const launch = chromium.launch;
let launched = 0;
chromium.launch = async () => { launched++; return { newContext: async () => ({}), close: async () => {} }; };
const isolatedPool = new balancePool.constructor();
await Promise.all(Array.from({ length: 4 }, () => isolatedPool.getContext()));
chromium.launch = launch;
assert.equal(launched, 4);
console.log(JSON.stringify({ probe: "balance_pool_concurrency", configuredMaximum: 2, launched }));
console.log("Offline probes completed; all assertions passed.");
// The application's rate limiter owns a permanent cleanup interval.
process.exit(0);
