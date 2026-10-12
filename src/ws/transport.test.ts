import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { broadcastText, pingClient, sendText } from "./transport.js";

function client(state: number = WebSocket.OPEN) {
  const stateful = {
    readyState: state,
    sent: [] as string[],
    pings: 0,
    terminated: false,
    send: (message: string, _callback: (error?: Error) => void) => { stateful.sent.push(message); },
    ping: (_data: unknown, _mask: unknown, _callback: (error?: Error) => void) => { stateful.pings++; },
    terminate: () => {
      stateful.terminated = true;
      stateful.readyState = WebSocket.CLOSED;
    },
  };
  return { stateful, socket: stateful as unknown as WebSocket };
}

test("one synchronous send failure cannot block healthy clients or the next round", (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const broken = client();
  const healthy = client();
  broken.stateful.send = () => { throw new Error("socket write failed"); };
  const sockets = [broken.socket, healthy.socket];
  broadcastText(sockets, "round-1");
  broadcastText(sockets, "round-2");
  assert.deepEqual(healthy.stateful.sent, ["round-1", "round-2"]);
  assert.equal(broken.stateful.terminated, true);
  assert.equal(log.mock.callCount(), 1);
});

test("asynchronous write failure terminates only the affected client", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const broken = client();
  const healthy = client();
  broken.stateful.send = (_message, callback) => {
    setImmediate(() => callback(new Error("connection reset")));
  };
  broadcastText([broken.socket, healthy.socket], "round-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(broken.stateful.terminated, true);
  assert.equal(healthy.stateful.terminated, false);
  assert.deepEqual(healthy.stateful.sent, ["round-1"]);
  assert.equal(log.mock.callCount(), 1);
});

test("closing and closed clients are skipped for sends and pings", () => {
  for (const state of [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
    const inactive = client(state);
    sendText(inactive.socket, "round");
    pingClient(inactive.socket);
    assert.deepEqual(inactive.stateful.sent, []);
    assert.equal(inactive.stateful.pings, 0);
  }
});

test("heartbeat send failures do not interrupt healthy clients", (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const broken = client();
  const healthy = client();
  broken.stateful.ping = () => { throw new Error("ping failed"); };
  for (const socket of [broken.socket, healthy.socket]) pingClient(socket);
  assert.equal(broken.stateful.terminated, true);
  assert.equal(healthy.stateful.pings, 1);
  assert.equal(log.mock.callCount(), 1);
});

test("asynchronous ping failures terminate the affected client", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const broken = client();
  broken.stateful.ping = (_data, _mask, callback) => {
    setImmediate(() => callback(new Error("ping write failed")));
  };
  pingClient(broken.socket);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(broken.stateful.terminated, true);
  assert.equal(log.mock.callCount(), 1);
});
