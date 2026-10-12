import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Browser } from "playwright";
import { GameScraper, type RoundData } from "./scraper.js";

const history = { busts: Array.from({length:40},(_,index)=>1.1+index/10), metricsComplete:false };
const flush = async () => { for(let i=0;i<30;i++)await Promise.resolve(); };
function fixture(t: TestContext) {
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.UTC(2026,9,12)});
  let status=503, launches=0, closes=0;
  const batches: RoundData[][]=[];
  const page={exposeFunction:async()=>{},goto:async()=>({status:()=>status}),evaluate:async()=>({busts:history.busts.map(value=>`${value}x`),counts:[],amounts:[],profits:[]})};
  const scraper=new GameScraper({launch:async()=>{
    launches++;const browser=new EventEmitter() as EventEmitter & {newPage:()=>Promise<typeof page>;close:()=>Promise<void>};
    browser.newPage=async()=>page;browser.close=async()=>{closes++;};return browser as unknown as Browser;
  }});
  const internal=scraper as unknown as { setupObserver:()=>Promise<void>;scrapeGameData:()=>Promise<typeof history>;checkForChanges:()=>Promise<void>;performScrape:()=>Promise<void>;scheduleScrape:()=>void;checkpoint:string;restartCount:number };
  internal.setupObserver=async()=>{};internal.scrapeGameData=async()=>history;
  scraper.setCaptureHandler(history.busts.slice(0,10).join("-"),async(batch)=>{batches.push(batch);},new Date().toISOString());
  t.after(()=>scraper.stop());
  return{scraper,internal,batches,setStatus:(value:number)=>{status=value;},freezeRead:()=>{page.evaluate=()=>new Promise(()=>{});},launches:()=>launches,closes:()=>closes};
}
test("48-hour upstream outage retains the checkpoint, retries within the cap and resumes only on new rounds",async t=>{
  const originalError=console.error,originalLog=console.log,originalWarn=console.warn;
  console.error=()=>{};console.log=()=>{};console.warn=()=>{};
  t.after(()=>{console.error=originalError;console.log=originalLog;console.warn=originalWarn;});
  const f=fixture(t);const checkpoint=f.internal.checkpoint;
  await f.scraper.start();const outage=f.scraper.getStatus().outageSince;
  assert.equal(f.scraper.getStatus().healthy,false);assert.equal(f.scraper.getStatus().sourceStatus,"unavailable");
  for(let i=0;i<2880;i++) {t.mock.timers.tick(60_000);await flush();const retry=f.scraper.getStatus().nextRetryAt;assert.ok(retry);assert.ok(Date.parse(retry)-Date.now()<=60_000);}
  assert.equal(f.scraper.getStatus().outageSince,outage);assert.equal(f.internal.checkpoint,checkpoint);assert.equal(f.batches.length,0);
  assert.ok(f.launches()>2800&&f.launches()<=2881);assert.equal(f.closes(),f.launches());
  f.setStatus(200);t.mock.timers.tick(60_000);await flush();
  assert.equal(f.scraper.getStatus().sourceStatus,"waiting");assert.equal(f.scraper.getStatus().healthy,false);assert.equal(f.internal.restartCount>10,true);
  f.internal.scrapeGameData=async()=>({...history,busts:[9.99,...history.busts].slice(0,40)});
  t.mock.timers.tick(30_000);await flush();
  assert.equal(f.batches.length,1);assert.equal(f.batches[0].length,1);assert.equal(f.batches[0][0].bust,9.99);
  assert.equal(f.scraper.getStatus().healthy,true);assert.equal(f.scraper.getStatus().outageSince,null);assert.equal(f.scraper.getStatus().restartCount,0);
  await f.internal.checkForChanges();assert.equal(f.batches.length,1,"recovery does not replay the same history");
});
test("busy DOM with unchanged history cannot keep collection healthy or reset source checks",async t=>{
  const f=fixture(t);f.setStatus(200);await f.scraper.start();assert.equal(f.scraper.getStatus().healthy,true);
  for(let i=0;i<30;i++){f.internal.scheduleScrape();t.mock.timers.tick(10_000);await flush();}
  assert.equal(f.batches.length,0);assert.equal(f.scraper.getStatus().healthy,false);assert.equal(f.scraper.getStatus().sourceStatus,"unavailable");assert.ok(f.scraper.getStatus().nextRetryAt);
});
test("stop cancels long-outage retries",async t=>{
  const f=fixture(t);await f.scraper.start();await f.scraper.stop();const launches=f.launches();t.mock.timers.tick(2*86_400_000);await flush();
  assert.equal(f.launches(),launches);assert.equal(f.scraper.getStatus().nextRetryAt,null);assert.equal(f.scraper.getStatus().sourceStatus,"stopped");
});
test("an in-flight source response after stop cannot create a phantom captured round",async t=>{
  const f=fixture(t);f.setStatus(200);await f.scraper.start();
  let release!:(data:typeof history)=>void;
  f.internal.scrapeGameData=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.internal.performScrape();await f.scraper.stop();release({...history,busts:[8.88,...history.busts].slice(0,40)});await pending;
  assert.equal(f.batches.length,0);assert.equal(f.scraper.getStatus().nextRetryAt,null);
});
test("a hung browser history read times out and schedules recovery",async t=>{
  const f=fixture(t);f.setStatus(200);await f.scraper.start();
  f.internal.scrapeGameData=(GameScraper.prototype as unknown as {scrapeGameData:()=>Promise<typeof history>}).scrapeGameData.bind(f.scraper);
  f.freezeRead();const pending=f.internal.performScrape();t.mock.timers.tick(15_000);await flush();await pending;
  assert.equal(f.batches.length,0);assert.equal(f.closes(),1);assert.equal(f.scraper.getStatus().healthy,false);assert.ok(f.scraper.getStatus().nextRetryAt);
});
