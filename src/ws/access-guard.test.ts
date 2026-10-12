import test from "node:test";
import assert from "node:assert/strict";
import { SocketAccessGuard } from "./access-guard.js";

test("open socket stops receiving when logout or suspension revokes access", async () => {
  let session: any = { user: { accessStatus: "active" }, session: { expiresAt: new Date(Date.now() + 60_000) } };
  let sends = 0, closed = 0;
  const guard = new SocketAccessGuard(async () => session, () => closed++);
  await guard.send(() => sends++);
  session.user.accessStatus = "suspended";
  await guard.send(() => sends++);
  assert.equal(sends, 1); assert.equal(closed, 1);
  const logout = new SocketAccessGuard(async () => null, () => closed++);
  await logout.send(() => sends++);
  assert.equal(sends, 1); assert.equal(closed, 2);
});

test("socket closes at expiry even while idle", async () => {
  let closed = 0;
  const guard = new SocketAccessGuard(async () => ({ user: { role: "admin" }, session: { expiresAt: new Date(Date.now() + 25) } }), () => closed++);
  await guard.send(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(closed, 1);
});

test("authorization database errors close only the affected socket", async () => {
  let closed = false;
  const guard = new SocketAccessGuard(async () => { throw new Error("offline"); }, () => { closed = true; });
  await guard.send(() => assert.fail("must not send"));
  assert.equal(closed, true);
});
