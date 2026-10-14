import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { accountBalance, checkPakakumiBalance, loginPakakumi, nationalPhone, PakakumiGamePage, type ProviderRound } from "./pakakumi-page.js";

const browser = await chromium.launch({ headless: true,
  channel: process.env.PLAYWRIGHT_TEST_CHANNEL || (process.platform === "win32" ? "chrome" : undefined) });
after(() => browser.close());

// All requests are intercepted. No provider accounts, funds or services are used.
const html = `<form><label for="phone">Phone number</label><input id="phone" type="text">
  <label for="password">Password</label><input id="password" type="password">
  <button id="login">LOGIN</button></form>
  <label for="amount">Amount</label><input id="amount" type="number" value="10">
  <label for="cashout">Auto Cashout (X)</label><input id="cashout" type="number" value="2">
  <button id="bet">Bet</button><script type="module" src="/fixture-app.js"></script>`;
const app = `const handlers = {};
  export const bus = { on: (event, fn) => (handlers[event] ||= []).push(fn),
    off(event, fn) { handlers[event] = (handlers[event] || []).filter(item => item !== fn); }, reconnect() {},
    emit(event, request, callback) {
      if (!window.insideBetClick) throw Error('Adapter must never send game events');
      if (window.acceptBet) { bus.fire('1506', { user_id: 7, idx: 0, currency: 'KES', game_id: window.nextGameId || 100,
        bet: request.amount, stopped_at: null }); callback({}); }
    },
    fire(event, data) { for (const fn of handlers[event] || []) fn(data); } };
  window.testBus = bus; window.betClicks = 0; window.acceptBet = true;
  document.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const reply = await fetch('https://api.pakakumi.com/auth/login', { method: 'POST', body: JSON.stringify({
      phone: '+254' + document.querySelector('#phone').value, password: document.querySelector('#password').value
    }) });
    if (reply.ok) { await fetch('https://api.pakakumi.com/accounts/me'); history.pushState({}, '', '/crash'); }
  };
  document.querySelector('#bet').onclick = () => {
    window.betClicks++; document.querySelector('#bet').disabled = true;
    window.insideBetClick = true;
    bus.emit('1506', { amount: Number(document.querySelector('#amount').value), autoCashout: Number(document.querySelector('#cashout').value), idx: 0, currency: 'KES' }, () => {});
    window.insideBetClick = false;
  };
  await fetch('https://api.pakakumi.com/config');`;

async function fixture(rejectLogin = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: { path: string; body: string | null }[] = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    requests.push({ path: url.pathname, body: route.request().postData() });
    const cors = { "access-control-allow-origin": "*" };
    if (url.pathname === "/fixture-app.js") return route.fulfill({ contentType: "text/javascript", body: app });
    if (url.pathname === "/config") return route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify({ currency: "KES", "crash.min_wager": 10, "crash.max_wager": 5000 }) });
    if (url.pathname === "/auth/login") return route.fulfill({ status: rejectLogin ? 401 : 200, contentType: "application/json", headers: cors, body: JSON.stringify(rejectLogin ? { message: "do-not-log-fixture-password" } : { id: 7 }) });
    if (url.pathname === "/accounts/me") return route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify({ accounts: [{ currency: "KES", wallets: [{ wallet: "default", balance: 0 }] }] }) });
    if (url.origin === "https://pakakumi.com") return route.fulfill({ contentType: "text/html", body: html });
    throw new Error("Unexpected fixture request");
  });
  return { page, context, requests };
}

async function emit(page: import("playwright").Page, event: string, data?: unknown) {
  await page.evaluate(({ event, data }) => {
    (window as any).testBus.fire(event, data);
  }, { event, data });
}

test("Kenyan numbers are normalized for the current +254 phone field", () => {
  for (const phone of ["0712345678", "+254712345678", "254712345678", "712345678"]) assert.equal(nationalPhone(phone), "712345678");
  assert.throws(() => nationalPhone("123"));
});

test("wallet balances preserve real zeroes and include playable bonus funds", () => {
  assert.equal(accountBalance({ accounts: [{ currency: "KES", wallets: [{ balance: 0 }] }] }), 0);
  assert.equal(accountBalance({ accounts: [{ currency: "KES", wallets: [{ balance: 100 }, { balance: 25.5 }, { balance: -1 }] }] }), 125.5);
  for (const invalid of [null, {}, { accounts: [] }, { accounts: [{ currency: "KES", wallets: [{ balance: "100" }] }] }]) {
    assert.throws(() => accountBalance(invalid));
  }
});

test("current labelled login confirms the provider reply and reads a zero balance without hydration polling", async () => {
  const { page, context, requests } = await fixture();
  try {
    assert.equal(await checkPakakumiBalance(page, "+254712345678", "fixture-password"), 0);
    const submitted = requests.find(r => r.path === "/auth/login");
    assert.equal(JSON.parse(submitted!.body!).phone, "+254712345678");
    assert.equal(requests.filter(r => r.path === "/accounts/me").length, 1);
  } finally { await context.close(); }
});

test("rejected login cannot be mistaken for success or expose the password", async () => {
  const { page, context } = await fixture(true);
  try {
    await assert.rejects(loginPakakumi(page, "0712345678", "do-not-log-fixture-password"), error => {
      assert.match((error as Error).message, /login could not be confirmed/);
      assert.ok(!(error as Error).message.includes("do-not-log-fixture-password"));
      return true;
    });
    assert.equal(new URL(page.url()).pathname, "/login");
  } finally { await context.close(); }
});

test("new round events distinguish identical busts, record early payouts, and stop on lost connection", async () => {
  const { page, context } = await fixture();
  const rounds: ProviderRound[] = [], errors: Error[] = [];
  const game = new PakakumiGamePage(page);
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async round => { rounds.push(round); }, error => { errors.push(error); });
    assert.equal(await game.phase(), "unknown");
    await emit(page, "1501");
    assert.equal(await game.phase(), "waiting");
    await emit(page, "1506", { user_id: 7, idx: 0, currency: "KES", game_id: 100, bet: 10 });
    await emit(page, "1505", { 7: { 0: 1.5 } });
    // A duplicate player batch must not erase the observed cashout.
    await emit(page, "1507", { plays: [{ user_id: 7, idx: 0, currency: "KES", game_id: 100, bet: 10 }] });
    await emit(page, "1504", { gameId: 100, gameCrash: 2 });
    await emit(page, "1504", { gameId: 100, gameCrash: 2 });
    await emit(page, "1504", { gameId: 101, gameCrash: 2 });
    await page.waitForTimeout(25);
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0]?.settlement?.grossPayout, 15);
    assert.equal(rounds[1]?.settlement, null);
    await emit(page, "disconnect");
    await emit(page, "1501");
    await page.waitForTimeout(25);
    assert.equal(await game.phase(), "unknown");
    assert.equal(errors.length, 1);
  } finally { await context.close(); }
});

test("bet controls reject unsupported stakes and require a new accepted own bet", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page);
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async () => {}, () => {});
    await emit(page, "1501");
    await assert.rejects(game.placeBet(5, 2), /between 10 and 5000/);
    await assert.rejects(game.placeBet(5001, 2), /between 10 and 5000/);
    await assert.rejects(game.placeBet(10, 3001), /published 3000x game limit/);
    assert.equal(await page.evaluate("window.betClicks"), 0);
    assert.equal(await game.placeBet(10, 2), "100");
    assert.equal(await page.getByLabel("Amount", { exact: true }).inputValue(), "10");
    assert.equal(await page.getByLabel("Auto Cashout (X)", { exact: true }).inputValue(), "2");
  } finally { await context.close(); }
});

test("a disabled or queued button is not proof that a bet was accepted", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page);
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async () => {}, () => {});
    await page.evaluate("window.acceptBet = false");
    await emit(page, "1501");
    await assert.rejects(game.placeBet(10, 2), /could not be confirmed/);
    assert.equal(await page.evaluate("window.betClicks"), 1);
  } finally { await context.close(); }
});

test("stale countdowns cannot open a betting window", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page);
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async () => {}, () => {});
    await emit(page, "1501");
    await page.evaluate("window.__pakakumiGame.waitingAt = Date.now() - 5001");
    await assert.rejects(game.placeBet(10, 2), /window closed/);
    assert.equal(await page.evaluate("window.betClicks"), 0);
  } finally { await context.close(); }
});

test("a connected page stops execution after five minutes without game updates", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page), errors: Error[] = [];
  try {
    await page.clock.install();
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async () => {}, error => { errors.push(error); });
    await page.clock.fastForward(300_001);
    assert.equal(await game.phase(), "unknown");
    await page.waitForFunction(() => (window as any).__pakakumiGame.failed);
    assert.equal(errors.length, 1);
    assert.equal(await page.evaluate("window.betClicks"), 0);
  } finally { await context.close(); }
});

test("a forced termination with an unsettled own bet is not recorded as a loss", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page), rounds: ProviderRound[] = [], errors: Error[] = [];
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async round => { rounds.push(round); }, error => { errors.push(error); });
    await emit(page, "1506", { user_id: 7, idx: 0, currency: "KES", game_id: 100, bet: 10 });
    await emit(page, "1504", { gameId: 100, gameCrash: 1, forced: true });
    await page.waitForTimeout(25);
    assert.equal(rounds.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(await game.phase(), "unknown");
  } finally { await context.close(); }
});

test("another browser's own-account broadcast cannot confirm this page's request", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page);
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async () => {}, () => {});
    await page.evaluate("window.acceptBet = false");
    await emit(page, "1501");
    const placement = game.placeBet(10, 2);
    const rejected = assert.rejects(placement, /could not be confirmed/);
    await page.waitForFunction("window.betClicks === 1");
    await emit(page, "1506", { user_id: 7, idx: 0, currency: "KES", game_id: 999, bet: 10 });
    await rejected;
  } finally { await game.dispose(); await context.close(); }
});

test("a stop check after filling controls prevents the UI bet request", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page);
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async () => {}, () => {});
    await emit(page, "1501");
    await assert.rejects(game.placeBet(10, 2, async () => false), /stopped before submission/);
    assert.equal(await page.evaluate("window.betClicks"), 0);
  } finally { await game.dispose(); await context.close(); }
});

test("provider reload ends observation; deliberate cleanup releases listeners without reporting a failure", async () => {
  const { page, context } = await fixture();
  const game = new PakakumiGamePage(page), errors: Error[] = [];
  try {
    await page.goto("https://pakakumi.com/crash");
    await game.observe("7", async () => {}, error => { errors.push(error); });
    await page.reload();
    assert.equal(errors.length, 1);
    assert.equal(await game.phase(), "unknown");
  } finally { await game.dispose(); await context.close(); }
  const second = await fixture();
  const observer = new PakakumiGamePage(second.page), deliberate: Error[] = [];
  try {
    await second.page.goto("https://pakakumi.com/crash");
    await observer.observe("7", async () => {}, error => { deliberate.push(error); });
    await observer.dispose();
    await emit(second.page, "disconnect");
    await second.page.close();
    assert.equal(deliberate.length, 0);
    assert.equal(await observer.phase(), "unknown");
  } finally { await second.context.close(); }
});
