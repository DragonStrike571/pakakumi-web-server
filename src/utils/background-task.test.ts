import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runBackgroundTask } from "./background-task.js";

const flushTasks = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a failed round event logs its error and later rounds still run", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const events = new EventEmitter();
  const savedRounds: number[] = [];
  const error = new Error("post-save broadcast failed");
  events.on("roundEnded", (round: number) => {
    runBackgroundTask("Round event processing", async () => {
      savedRounds.push(round);
      if (round === 1) throw error;
    });
  });
  events.emit("roundEnded", 1);
  await flushTasks();
  events.emit("roundEnded", 2);
  await flushTasks();
  assert.deepEqual(savedRounds, [1, 2]);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments, ["❌ Round event processing failed:", error]);
});

test("background task boundary also contains synchronous throws", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const error = new Error("recovery failed before returning a promise");
  assert.equal(runBackgroundTask("Scraper restart", () => { throw error; }), undefined);
  await flushTasks();
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments, ["❌ Scraper restart failed:", error]);
});
