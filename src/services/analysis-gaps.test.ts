import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/test";
const { db, pool } = await import("../db/index.js");
pool.query = (async () => { throw new Error("External database disabled in gap tests"); }) as typeof pool.query;
const { getGapAnalysis } = await import("./analysis-gaps.js");
async function fixture(busts: number[]) {
  const pg = new PGlite();
  await pg.exec("CREATE TABLE rounds (id integer, bust numeric, created_at timestamp); SET TIME ZONE 'UTC';");
  for (const [index, bust] of busts.entries()) await pg.query("INSERT INTO rounds VALUES ($1,$2,$3)", [index,bust,new Date(Date.UTC(2026,9,10,10,index)).toISOString()]);
  return { pg, database: drizzle(pg) as unknown as typeof db };
}
test("gap query handles empty and fresh histories without a 3000x milestone", async () => {
  const {pg,database}=await fixture([]);
  try {
    const empty=await getGapAnalysis(2,25,database); assert.equal(empty.totalRounds,0);assert.deepEqual(empty.points,[]);assert.equal(empty.latestRoundAt,null);
    await pg.query("INSERT INTO rounds VALUES (1,2,'2026-10-10 10:00:00'),(2,1,'2026-10-10 10:01:00'),(3,3,'2026-10-10 10:02:00')");
    const result=await getGapAnalysis(2,25,database);assert.equal(result.scope,"all-history");assert.equal(result.expectedMeanGap,1.5);assert.deepEqual(result.points.map(p=>p.gap),[1,2]);assert.equal(result.points.at(-1)!.createdAt,"2026-10-10T10:02:00.000Z");
  } finally { await pg.close(); }
});
test("gap query scopes below-3000 targets to latest milestone and limits points without losing occurrence numbers",async()=>{
  const {pg,database}=await fixture([2,3000,2,1,2,3000,1,2,2,1,2]);
  try {
    const result=await getGapAnalysis(2,2,database);assert.equal(result.scope,"since-3000");assert.equal(result.scopedRounds,5);assert.equal(result.scopedHits,3);assert.deepEqual(result.points.map(p=>[p.occurrence,p.gap,p.cumulativeRound]),[[2,1,3],[3,2,5]]);
    const high=await getGapAnalysis(3000,25,database);assert.equal(high.scope,"all-history");assert.deepEqual(high.points.map(p=>p.gap),[2,4]);
  }finally{await pg.close();}
});
test("heavy gap queries leave connection capacity for collection and recover after completing",async()=>{
  const releases: (()=>void)[]=[];
  const database={execute:()=>new Promise(resolve=>releases.push(()=>resolve({rows:[{analysis:{target:2}}]})))} as unknown as typeof db;
  const first=getGapAnalysis(2,25,database),second=getGapAnalysis(3,25,database);
  await assert.rejects(getGapAnalysis(4,25,database),/busy/);assert.equal(releases.length,2);
  releases.forEach(release=>release());await Promise.all([first,second]);
  const retry=getGapAnalysis(4,25,database);releases.at(-1)!();await retry;
});
