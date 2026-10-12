import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CollectionInbox } from "./collection-inbox.js";
import { GameScraper, type RoundData } from "./scraper.js";

const round = (bust: number): RoundData => ({ bust, bustId: String(bust), playersOnline: null, playersPlaying: null,
  totalAmountPlayed: null, totalAmountWon: null, totalAmountLost: null, averageAmountPlayed: null, maxAmountPlayed: null, metricsComplete: false });
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test("a database outage preserves observations and their IDs across restart", async () => {
  await mkdir("data", { recursive: true });
  const directory = await mkdtemp(join(resolve("data"), "test-inbox-"));
  const path = join(directory, "inbox.json");
  const first = new CollectionInbox(path, async () => { throw new Error("database unavailable"); });
  let second: CollectionInbox | undefined;
  try {
    await first.initialize("old");
    await first.capture([round(1.2), round(2)], "new");
    await settle();
    await first.drain();
    const persisted = JSON.parse(await readFile(path, "utf8"));
    const saved: string[] = [];
    second = new CollectionInbox(path, async value => { saved.push(value.ingestionId); });
    assert.equal(await second.initialize("old"), "new");
    await settle(); await second.drain();
    assert.deepEqual(saved, persisted.pending.map((r: any) => r.ingestionId));
    assert.equal(JSON.parse(await readFile(path, "utf8")).pending.length, 0);
  } finally { await first.drain(); await second?.drain(); await rm(directory, { recursive: true, force: true }); }
});

const snapshot = { busts: Array.from({ length: 40 }, (_, i) => 1.1 + i / 10), onlineCount: 10, playingCount: 2,
  totalCashPlayed: 20, totalWinAmount: 5, totalLossAmount: 10, averageSpending: 10, maxSpending: 10, metricsComplete: true };

test("cold scraper resumes after the database checkpoint and retries failed capture", async () => {
  const scraper: any = new GameScraper();
  scraper.scrapeGameData = async () => snapshot;
  const checkpoint = snapshot.busts.slice(3, 13).join("-");
  let attempts = 0;
  const received: RoundData[][] = [];
  scraper.setCaptureHandler(checkpoint, async (batch: RoundData[]) => {
    attempts++; if (attempts === 1) throw new Error("disk full"); received.push(batch);
  });
  await assert.rejects(scraper.checkForChanges(), /disk full/);
  await scraper.checkForChanges();
  await scraper.checkForChanges();
  assert.equal(attempts, 2);
  assert.deepEqual(received[0]!.map(r => r.bust), snapshot.busts.slice(0, 3).reverse());
  assert.equal(received[0]![0]!.metricsComplete, false);
  assert.equal(received[0]![2]!.metricsComplete, true);
});

test("missing checkpoint records an explicit gap instead of dropping visible rounds", async () => {
  const scraper: any = new GameScraper();
  scraper.scrapeGameData = async () => snapshot;
  let batch: RoundData[] = [];
  scraper.setCaptureHandler("missing", async (value: RoundData[]) => { batch = value; });
  await scraper.checkForChanges();
  assert.equal(batch.length, 31); assert.equal(batch[0]!.sourceGap, true);
});

test("empty or partial player tables never produce complete zero financial metrics", async () => {
  const scraper: any = new GameScraper();
  scraper.page = { evaluate: async () => ({ busts: snapshot.busts.map(b => `${b}x`), counts: ["10", "7"], amounts: [], profits: [] }) };
  const data = await scraper.scrapeGameData();
  assert.equal(data.metricsComplete, false);
  let batch: RoundData[] = [];
  scraper.setCaptureHandler(snapshot.busts.slice(1, 11).join("-"), async (value: RoundData[]) => { batch = value; });
  await scraper.checkForChanges();
  assert.equal(batch[0]!.metricsComplete, false); assert.equal(batch[0]!.totalAmountPlayed, null);
});

test("scraper continues scheduling recovery after ten startup failures", async () => {
  const scraper: any = new GameScraper();
  scraper.desiredRunning = true; scraper.restartCount = 10;
  scraper.scheduleRestart(10);
  assert.equal(scraper.desiredRunning, true); assert.equal(scraper.getStatus().recovering, true);
  await scraper.stop();
});
