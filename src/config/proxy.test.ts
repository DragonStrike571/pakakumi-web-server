import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolveProxyTrust } from "./proxy.js";

test("same-VPS proxy trust defaults to loopback; explicit settings remain bounded", () => {
  assert.deepEqual(resolveProxyTrust({}), ["loopback"]);
  assert.deepEqual(resolveProxyTrust({ TRUST_PROXY_ADDRESSES: "loopback", TRUST_PROXY_HOPS: "0" }), ["loopback"]);
  assert.deepEqual(resolveProxyTrust({ TRUST_PROXY_ADDRESSES: "10.1.2.3,2001:db8::/64" }), ["10.1.2.3","2001:db8::/64"]);
  assert.equal(resolveProxyTrust({ TRUST_PROXY_ADDRESSES: "none" }), false);
  assert.equal(resolveProxyTrust({ TRUST_PROXY_HOPS: "0" }), false);
  assert.equal(resolveProxyTrust({ TRUST_PROXY_HOPS: "1" }), 1);
  for (const value of ["true", "", "0.0.0.0/33", "2001:db8::/129", "loopback,"]) assert.throws(() => resolveProxyTrust({ TRUST_PROXY_ADDRESSES: value }));
  for (const value of ["true", "-1", "1.5", "6", ""]) assert.throws(() => resolveProxyTrust({ TRUST_PROXY_HOPS: value }));
});

test("Nginx headers keep per-client rate limits and do not log proxy validation errors", async t => {
  const app = express(); app.set("trust proxy", resolveProxyTrust({}));
  const trust = app.get("trust proxy fn") as (address: string, hop: number) => boolean;
  assert.equal(trust("127.0.0.1",0),true); assert.equal(trust("::ffff:127.0.0.1",0),true);
  assert.equal(trust("203.0.113.5",0),false,"a direct remote connection cannot spoof X-Forwarded-For");
  const errors: unknown[][]=[];const original=console.error;console.error=(...args)=>{errors.push(args);};t.after(()=>{console.error=original;});
  app.use(rateLimit({ windowMs:60_000,limit:2 }));app.get("/api/auth/get-session",(req,res)=>res.json({ip:req.ip,protocol:req.protocol}));
  const server=createServer(app);t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const send=(ip:string)=>fetch(`http://127.0.0.1:${address.port}/api/auth/get-session`,{headers:{"X-Forwarded-For":ip,"X-Forwarded-Proto":"https"}});
  const first=await send("198.51.100.1");assert.deepEqual(await first.json(),{ip:"198.51.100.1",protocol:"https"});
  assert.equal((await send("198.51.100.1")).status,200);assert.equal((await send("198.51.100.1")).status,429);
  assert.equal((await send("198.51.100.2")).status,200);assert.deepEqual(errors,[]);
});
