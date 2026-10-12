import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, truncateHtml } from "./html.js";
import { shutdownWithDeadline } from "./shutdown.js";

test("HTML escaping preserves literal user text; truncation closes tags and entities", () => {
  assert.equal(escapeHtml('<admin> & "x"'), '&lt;admin&gt; &amp; &quot;x&quot;');
  const message = truncateHtml(`<b>${escapeHtml("💥<&".repeat(3000))}</b>`);
  assert.match(message, /<\/b>\n\n\[truncated\]$/);
  assert.doesNotMatch(message, /&(lt|amp)?<\/b>/);
  assert.equal(truncateHtml("<b>small</b>"), "<b>small</b>");
});

test("shutdown deadline exits even when the first resource never closes", async () => {
  let calls = 0;
  await new Promise<void>(resolve => {
    void shutdownWithDeadline(() => new Promise(() => undefined), code => {
      calls++; assert.equal(code, 1); resolve();
    }, 0, 20);
  });
  assert.equal(calls, 1);
});

test("completed shutdown clears its deadline", async () => {
  const codes: number[] = [];
  await shutdownWithDeadline(async () => undefined, code => codes.push(code), 0, 20);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(codes, [0]);
});
