import assert from "node:assert/strict";
import test from "node:test";
import { Bot, BotError } from "grammy";
import { getBotUsername } from "./bot-identity.js";
import { createSessionStateMiddleware, type SessionContext } from "./session-state.js";
import { runQueueWorker } from "./queue-worker.js";

const botInfo: Bot["botInfo"] = {
  id: 999,
  is_bot: true as const,
  first_name: "Offline test bot",
  username: "test_oracle_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const update = (id: number) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    text: "/start",
    from: { id: 123, is_bot: false, first_name: "Test", username: "test_user" },
    chat: { id: 123, type: "private" as const, first_name: "Test" },
  },
});
const flushTasks = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a failed Telegram command runs once and its original error reaches grammY", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const bot = new Bot<SessionContext>("999:offline-test", { botInfo });
  const sessions = createSessionStateMiddleware<SessionContext>(async (chatId, username) => {
    assert.equal(chatId, "123");
    assert.equal(username, "test_user");
    return "support";
  });
  bot.use(sessions.middleware);
  let calls = 0;
  const error = new Error("command API request failed");
  bot.on("message:text", (ctx) => {
    calls++;
    assert.equal(ctx.dbState, "support");
    if (ctx.update.update_id === 1) throw error;
  });
  await assert.rejects(bot.handleUpdate(update(1)), (caught: unknown) =>
    caught instanceof BotError && caught.error === error,
  );
  assert.equal(calls, 1);
  assert.equal(log.mock.callCount(), 0, "command errors must not be reported as DB sync failures");
  await bot.handleUpdate(update(2));
  assert.equal(calls, 2, "the next update still processes normally");
});

test("session database failures use the fallback once and retry on the next update", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const bot = new Bot<SessionContext>("999:offline-test", { botInfo });
  let syncCalls = 0;
  const error = new Error("database unavailable");
  bot.use(createSessionStateMiddleware<SessionContext>(async () => {
    syncCalls++;
    throw error;
  }).middleware);
  let commandCalls = 0;
  bot.on("message:text", (ctx) => {
    commandCalls++;
    assert.equal(ctx.dbState, "command");
  });
  await bot.handleUpdate(update(1));
  await bot.handleUpdate(update(2));
  assert.equal(commandCalls, 2);
  assert.equal(syncCalls, 2);
  assert.equal(log.mock.callCount(), 2);
});

test("cached Telegram session state can still be invalidated", async () => {
  const bot = new Bot<SessionContext>("999:offline-test", { botInfo });
  let state = "support";
  let syncCalls = 0;
  const sessions = createSessionStateMiddleware<SessionContext>(async () => {
    syncCalls++;
    return state;
  });
  bot.use(sessions.middleware);
  const states: string[] = [];
  bot.on("message:text", (ctx) => { states.push(ctx.dbState); });
  await bot.handleUpdate(update(1));
  state = "command";
  await bot.handleUpdate(update(2));
  sessions.invalidate("123");
  await bot.handleUpdate(update(3));
  assert.deepEqual(states, ["support", "support", "command"]);
  assert.equal(syncCalls, 2);
});

test("analyzer identity lookup is safe before Telegram initialization", () => {
  const bot = new Bot("999:offline-test");
  assert.throws(() => bot.botInfo, /Bot information unavailable/);
  assert.equal(getBotUsername(bot), "pk_oracle_bot");
  assert.equal(getBotUsername(null), "pk_oracle_bot");
  bot.botInfo = botInfo;
  assert.equal(getBotUsername(bot), "test_oracle_bot");
});

test("escaped queue worker errors are logged and processing can resume", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  for (const work of [
    () => { throw new Error("synchronous worker failure"); },
    async () => { throw new Error("asynchronous worker failure"); },
  ]) {
    let recovered = false;
    let delivered = false;
    assert.equal(runQueueWorker(work, () => {
      recovered = true;
      runQueueWorker(async () => { delivered = true; }, () => {
        assert.fail("healthy work must not trigger recovery");
      });
    }), undefined);
    await flushTasks();
    assert.equal(recovered, true);
    assert.equal(delivered, true);
  }
  assert.equal(log.mock.callCount(), 2);
});

test("queue recovery failures are also contained", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  runQueueWorker(async () => { throw new Error("worker failure"); }, () => {
    throw new Error("recovery failure");
  });
  await flushTasks();
  assert.equal(log.mock.callCount(), 1);
});
