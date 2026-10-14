import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { GAME_SOURCE_READER, type GameSourceSnapshot } from "./game-source-dom.js";
import { GameScraper, type RoundData } from "./scraper.js";

const browser = await chromium.launch({ headless: true,
  channel: process.env.PLAYWRIGHT_TEST_CHANNEL || (process.platform === "win32" ? "chrome" : undefined) });
after(() => browser.close());
const values = Array.from({ length: 40 }, (_, i) => (2 + i / 100).toFixed(2));
const strip = (busts = values) => `<div id="wrapper"><div id="history" class="any-new-generated-class">${busts.map(bust => `<span class="also-any-class">${bust}</span>`).join("")}</div></div>`;
const read = (page: Page) => page.evaluate(GAME_SOURCE_READER) as Promise<GameSourceSnapshot | null>;

test("new history strip tolerates CSS changes, reads newest first and does not misinterpret the new player table", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(strip() + '<table><thead><tr><th>User</th><th>Bet KES</th><th>@</th><th>Win</th></tr></thead><tbody><tr><td>Player</td><td>100</td><td>2</td><td>200</td></tr></tbody></table>');
    const snapshot = await read(page);
    assert.equal(snapshot?.layout, "history-strip");
    assert.deepEqual(snapshot?.busts, values);
    assert.deepEqual(snapshot?.amounts, []);
    const scraper: any = new GameScraper(); scraper.page = page;
    assert.equal((await scraper.scrapeGameData()).metricsComplete, false);
  } finally { await page.close(); }
});

test("observer handles text changes, replaced history elements and reattaches after wrapper replacement", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(strip());
    await page.evaluate('window.__onDomChanged = () => { window.__signals = (window.__signals || 0) + 1; }');
    await read(page);
    await page.locator('#history span').first().evaluate(node => { node.firstChild!.textContent = "7.77"; });
    await page.waitForFunction('window.__signals >= 1');
    assert.equal((await read(page))?.busts[0], "7.77");
    await page.evaluate(html => { document.querySelector('#history')!.outerHTML = html; }, strip().replace('<div id="wrapper">', '').slice(0, -6));
    await page.waitForFunction('window.__signals >= 2');
    assert.deepEqual((await read(page))?.busts, values);
    await page.evaluate(html => { document.body.innerHTML = html; }, strip());
    await read(page);
    await page.locator('#history span').first().evaluate(node => { node.firstChild!.textContent = "8.88"; });
    await page.waitForFunction('window.__signals >= 3');
    assert.equal((await read(page))?.busts[0], "8.88");
  } finally { await page.close(); }
});

test("old history table and complete legacy financial metrics remain supported", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<table class="css-1a87jyo"><tbody>${values.map(value => `<tr class="css-15iar3s"><td><span class="css-hwpcld">${value}x</span></td></tr>`).join("")}</tbody></table>
      <div class="css-eb3kfa"><strong>10</strong><strong>2</strong></div>
      <div class="css-afms4i"><table class="css-1a87jyo"><tbody><tr><td>A</td><td>2</td><td>10</td><td>5</td></tr><tr><td>B</td><td>2</td><td>20</td><td>-20</td></tr></tbody></table></div>`);
    assert.equal((await read(page))?.layout, "history-table");
    const scraper: any = new GameScraper(); scraper.page = page;
    const result = await scraper.scrapeGameData();
    assert.equal(result.metricsComplete, true);
    assert.equal(result.totalCashPlayed, 30); assert.equal(result.totalWinAmount, 5); assert.equal(result.totalLossAmount, 20);
  } finally { await page.close(); }
});

test("new labelled player counters are captured without inventing financial totals for virtualized rows", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(strip() + '<div><span>Online</span><strong>500</strong></div><div><span>Playing</span><strong>255</strong></div><table><tbody><tr><td>Example</td><td>10</td><td>2</td><td>20</td></tr></tbody></table>');
    const scraper: any = new GameScraper(); scraper.page = page;
    const batches: RoundData[][] = [];
    scraper.setCaptureHandler(null, async (batch: RoundData[]) => { batches.push(batch); });
    await scraper.checkForChanges();
    const latest = batches[0]!.at(-1)!;
    assert.equal(latest.playersOnline, 500);
    assert.equal(latest.playersPlaying, 255);
    assert.equal(latest.metricsComplete, false);
    assert.equal(latest.totalAmountPlayed, null);
    assert.ok(batches[0]!.slice(0, -1).every(round => round.playersPlaying === null));
    await page.locator("strong").first().evaluate(node => { node.textContent = "0"; });
    const inconsistent: any = new GameScraper(); inconsistent.page = page;
    const rejectedCounts: RoundData[][] = [];
    inconsistent.setCaptureHandler(null, async (batch: RoundData[]) => { rejectedCounts.push(batch); });
    await inconsistent.checkForChanges();
    assert.ok(rejectedCounts[0]!.every(round => round.playersOnline === null && round.playersPlaying === null));
    assert.equal(rejectedCounts[0]!.length, batches[0]!.length);
  } finally { await page.close(); }
});

test("partial, malformed, conflicting and unrelated numeric displays cannot create rounds", async () => {
  const page = await browser.newPage();
  try {
    for (const html of [
      '<h1>Under maintenance</h1>', strip(values.slice(0, 9)),
      strip(["0", ...values.slice(1)]), strip(["bad value", ...values.slice(1)]),
      strip() + strip(["99.99", ...values.slice(1)]), `<form>${strip()}</form>`,
      `<table><tbody>${values.map(value => `<tr><td>Player</td><td>${value}</td></tr>`).join("")}</tbody></table>`,
    ]) {
      await page.setContent(html);
      assert.equal(await read(page), null);
      const scraper: any = new GameScraper(); scraper.page = page;
      let captures = 0;
      scraper.setCaptureHandler("retained-checkpoint", async () => { captures++; });
      await assert.rejects(scraper.checkForChanges(), /unavailable or incomplete/);
      assert.equal(captures, 0); assert.equal(scraper.checkpoint, "retained-checkpoint");
    }
  } finally { await page.close(); }
});

test("new-layout startup and observer capture the next round once with the durable checkpoint intact", async () => {
  const owned = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_TEST_CHANNEL || (process.platform === "win32" ? "chrome" : undefined) });
  const scraper = new GameScraper({ launch: async () => owned });
  const batches: RoundData[][] = [];
  let page!: Page;
  const newPage = owned.newPage.bind(owned);
  owned.newPage = async (...args) => {
    page = await newPage(...args);
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: strip() }));
    return page;
  };
  scraper.setCaptureHandler(values.slice(0, 10).map(Number).join("-"), async batch => { batches.push(batch); }, new Date().toISOString());
  try {
    await scraper.start();
    assert.equal(scraper.getStatus().healthy, true); assert.equal(batches.length, 0);
    await page.evaluate(html => { document.querySelector('#wrapper')!.innerHTML = html; }, strip(["7.77", ...values].slice(0, 40)).replace('<div id="wrapper">', '').slice(0, -6));
    const deadline = Date.now() + 5000;
    while (!batches.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(batches.length, 1); assert.equal(batches[0]!.length, 1); assert.equal(batches[0]![0]!.bust, 7.77);
    assert.equal(batches[0]![0]!.totalAmountWon, null);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(batches.length, 1);
  } finally { await scraper.stop(); }
});

test("real-browser startup failure closes cleanly and schedules retry without deleting Playwright listeners", async () => {
  const owned = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_TEST_CHANNEL || (process.platform === "win32" ? "chrome" : undefined) });
  const newPage = owned.newPage.bind(owned);
  owned.newPage = async (...args) => {
    const page = await newPage(...args);
    await page.route('**/*', route => route.fulfill({ status: 503, body: 'Under maintenance' }));
    return page;
  };
  const scraper = new GameScraper({ launch: async () => owned });
  try {
    await scraper.start();
    assert.equal(owned.isConnected(), false);
    assert.equal(scraper.getStatus().healthy, false);
    assert.equal(scraper.getStatus().recovering, true);
    assert.ok(scraper.getStatus().nextRetryAt);
  } finally { await scraper.stop(); }
});
