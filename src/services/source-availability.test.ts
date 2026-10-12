import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { gameScraper } from "./scraper.js";
import { requireHealthySource } from "../middleware/source.js";

test("outage blocks new provider operations without blocking saved data or stop requests",async t=>{
  const app=express();let healthy=false,created=0;
  const guard=requireHealthySource(()=>({...gameScraper.getStatus(),healthy,nextRetryAt:new Date(Date.now()+900_000).toISOString()}));
  app.post("/bot/start",guard,(_req,res)=>{created++;res.json({queued:true});});
  app.post("/account/balance",guard,(_req,res)=>res.json({balance:0}));
  app.get("/history",(_req,res)=>res.json({saved:true}));app.post("/bot/stop",(_req,res)=>res.json({stopped:true}));
  const server=createServer(app);t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address!=="string");const url=`http://127.0.0.1:${address.port}`;
  const start=await fetch(url+"/bot/start",{method:"POST"});assert.equal(start.status,503);assert.equal((await start.json()).code,"SOURCE_UNAVAILABLE");assert.equal(start.headers.get("Retry-After"),"900");
  assert.equal((await fetch(url+"/account/balance",{method:"POST"})).status,503);assert.equal(created,0);
  assert.equal((await fetch(url+"/history")).status,200);assert.equal((await fetch(url+"/bot/stop",{method:"POST"})).status,200);
  healthy=true;assert.equal((await fetch(url+"/bot/start",{method:"POST"})).status,200);assert.equal(created,1);
});
