import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, IncomingMessage, request } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createClientVerifier } from "./verify-client.js";
import { broadcastText, pingClient } from "./transport.js";

const allowedOrigin = "https://pakakumi.softdocs.org";
type GetSession = Parameters<typeof createClientVerifier>[1];
type Decision = [boolean, number | undefined, string | undefined];

function verify(origin: unknown, getSession: GetSession): Promise<Decision> {
  const req = new IncomingMessage(new Socket());
  req.headers.cookie = "better-auth.session_token=test-session";
  const verifier = createClientVerifier([allowedOrigin], getSession);
  let result: unknown;
  const decision = new Promise<Decision>((resolve) => {
    result = verifier({ origin: origin as string, secure: false, req }, (...decision) => {
      resolve([decision[0], decision[1], decision[2]]);
    });
  });
  assert.equal(result, undefined, "ws must receive a callback, not a promise");
  return decision;
}

test("missing, empty and non-string origins reject without looking up a session", async () => {
  let sessionCalls = 0;
  const getSession: GetSession = async () => {
    sessionCalls++;
    return { user: { role: "admin" } };
  };
  for (const origin of [undefined, null, "", "/", [], [allowedOrigin], 42]) {
    assert.deepEqual(await verify(origin, getSession), [false, 401, "Unauthorized"]);
  }
  assert.equal(sessionCalls, 0);
});

test("untrusted and malformed origins reject without authenticating", async () => {
  for (const origin of ["null", "not-a-url", "https://attacker.example", `${allowedOrigin}.attacker.example`, `${allowedOrigin}/path`]) {
    assert.deepEqual(await verify(origin, async () => {
      assert.fail("untrusted origins must not reach authentication");
    }), [false, 403, "Forbidden"]);
  }
});

test("allowed origins preserve session headers and admin/active/premium access", async () => {
  for (const user of [{ role: "admin" }, { accessStatus: "active" }, { accessStatus: "telegram_premium" }]) {
    for (const origin of [allowedOrigin, `${allowedOrigin}/`]) {
      assert.deepEqual(await verify(origin, async (headers) => {
        assert.equal(headers.cookie, "better-auth.session_token=test-session");
        return { user };
      }), [true, undefined, undefined]);
    }
  }
});

test("missing sessions and inactive accounts remain unauthorized", async () => {
  for (const session of [null, undefined, {}, { user: null }, { user: {} }, { user: { role: "user", accessStatus: "pending" } }]) {
    assert.deepEqual(await verify(allowedOrigin, async () => session), [false, 401, "Unauthorized"]);
  }
});

test("synchronous and asynchronous authentication failures reject with 503", async () => {
  const lookups: GetSession[] = [
    () => { throw new Error("header conversion failed"); },
    async () => { throw new Error("database unavailable"); },
  ];
  for (const lookup of lookups) {
    assert.deepEqual(await verify(allowedOrigin, lookup), [false, 503, "Authentication unavailable"]);
  }
});

test("upgrade callback failures close only the affected socket", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const req = new IncomingMessage(new Socket());
  const verifier = createClientVerifier([allowedOrigin], async () => ({ user: { role: "admin" } }));
  let callbackCalls = 0;
  verifier({ origin: allowedOrigin, secure: false, req }, () => {
    callbackCalls++;
    throw new Error("upgrade failed");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(callbackCalls, 1);
  assert.equal(req.socket.destroyed, true);
  assert.equal(log.mock.callCount(), 1);
});

function rejectedUpgrade(url: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(origin === undefined ? {} : { Origin: origin }),
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
      res.on("error", reject);
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("unauthorized request unexpectedly upgraded"));
    });
    req.on("error", reject);
    req.setTimeout(2_000, () => req.destroy(new Error("handshake timed out")));
    req.end();
  });
}

test("repeated rejected upgrades leave HTTP and authorized round streaming alive", { timeout: 10_000 }, async (t) => {
  let authUnavailable = false;
  let sessionCalls = 0;
  const httpServer = createServer((_req, res) => res.end("collector alive"));
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    verifyClient: createClientVerifier([allowedOrigin], async (headers) => {
      sessionCalls++;
      if (authUnavailable) throw new Error("database unavailable");
      return headers.cookie === "session=valid" ? { user: { accessStatus: "active" } } : null;
    }),
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Reproduce the headerless handshake from the production stack trace.
  assert.equal(await rejectedUpgrade(`${baseUrl}/ws`), 401);
  assert.equal(sessionCalls, 0);

  const client = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, {
    origin: allowedOrigin,
    headers: { Cookie: "session=valid" },
  });
  t.after(() => client.terminate());
  await once(client, "open");

  for (let i = 0; i < 20; i++) {
    assert.equal(await rejectedUpgrade(`${baseUrl}/ws`), 401);
  }
  assert.equal(await rejectedUpgrade(`${baseUrl}/ws`, ""), 401);
  assert.equal(await rejectedUpgrade(`${baseUrl}/ws`, "https://attacker.example"), 403);
  assert.equal(sessionCalls, 1, "invalid origins must not query authentication");
  assert.equal(await rejectedUpgrade(`${baseUrl}/ws`, allowedOrigin), 401);
  authUnavailable = true;
  assert.equal(await rejectedUpgrade(`${baseUrl}/ws`, allowedOrigin), 503);

  assert.equal(await (await fetch(`${baseUrl}/health`)).text(), "collector alive");
  const roundReceived = once(client, "message");
  const round = JSON.stringify({ type: "roundUpdate", data: { bust: 1.41 } });
  broadcastText(wss.clients, round);
  const [message] = await roundReceived;
  assert.equal(message.toString(), round);
  assert.equal(client.readyState, WebSocket.OPEN);

  const pingReceived = once(client, "ping");
  for (const socket of wss.clients) pingClient(socket);
  await pingReceived;

  authUnavailable = false;
  const recoveredClient = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, {
    origin: allowedOrigin,
    headers: { Cookie: "session=valid" },
  });
  t.after(() => recoveredClient.terminate());
  await once(recoveredClient, "open");
  assert.equal(wss.clients.size, 2, "new clients can connect after authentication recovers");
});
