import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Browser } from "playwright";
import { BalancePool } from "./balance-pool.js";

test("parallel balance requests share one launch and reserve at most four contexts", async () => {
  let launches = 0, active = 0, maximum = 0;
  const browser = Object.assign(new EventEmitter(), {
    isConnected: () => true, close: async () => undefined,
    newContext: async () => {
      active++; maximum = Math.max(maximum, active);
      const context = new EventEmitter();
      return Object.assign(context, { close: async () => { active--; context.emit("close"); } });
    },
  });
  const pool = new BalancePool(async () => { launches++; await new Promise(resolve => setTimeout(resolve, 10)); return browser as unknown as Browser; });
  try {
    const first = await Promise.all(Array.from({ length: 4 }, () => pool.getContext()));
    const controller = new AbortController();
    const waiting = pool.getContext(controller.signal);
    controller.abort();
    await assert.rejects(waiting, /cancel|abort/i);
    assert.equal(launches, 1); assert.equal(maximum, 4);
    await Promise.all(first.map(value => pool.releaseContext(value.context)));
    assert.equal(active, 0);
  } finally { await pool.shutdown(); }
});

test("context creation failure does not consume capacity and dead browsers are evicted", async () => {
  let connected = true, launches = 0, fail = true;
  const browser = Object.assign(new EventEmitter(), { isConnected: () => connected, close: async () => undefined,
    newContext: async () => {
      if (fail) { fail = false; throw new Error("context failed"); }
      const context = new EventEmitter();
      return Object.assign(context, { close: async () => { context.emit("close"); } });
    } });
  const pool = new BalancePool(async () => { launches++; connected = true; return browser as unknown as Browser; });
  try {
    await assert.rejects(pool.getContext(), /context failed/);
    const first = await pool.getContext(); await pool.releaseContext(first.context);
    connected = false;
    const second = await pool.getContext(); assert.equal(launches, 2); await pool.releaseContext(second.context);
  } finally { await pool.shutdown(); }
});
