import type { Page, Response, Frame } from "playwright";

async function deadline<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export const PAKAKUMI_LOGIN_URL = "https://pakakumi.com/login";
export const PAKAKUMI_GAME_URL = "https://pakakumi.com/crash";

function sourceResponse(url: string, path: string) {
  const parsed = new URL(url);
  return parsed.origin === "https://api.pakakumi.com" && parsed.pathname === path;
}

// The current phone field already supplies +254. Passing the country code into
// that field would send a doubled prefix. Never log the response or credentials.
export function nationalPhone(phone: string) {
  const digits = phone.replace(/[\s()+-]/g, "");
  if (/^254\d{9}$/.test(digits)) return digits.slice(3);
  if (/^0\d{9}$/.test(digits)) return digits.slice(1);
  if (/^\d{9}$/.test(digits)) return digits;
  throw new Error("Pakakumi phone number must be a valid Kenyan mobile number");
}

async function submitLogin(page: Page, phone: string, password: string) {
  await page.goto(PAKAKUMI_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const phoneInput = page.getByLabel("Phone number", { exact: true });
  await phoneInput.waitFor({ state: "visible", timeout: 10_000 });
  await phoneInput.fill(nationalPhone(phone));
  await page.getByLabel("Password", { exact: true }).fill(password);
  const submit = page.locator("form").getByRole("button", { name: /^login$/i });
  // Start listening before clicking: fast replies must not be missed.
  const [response] = await Promise.all([
    page.waitForResponse(r => sourceResponse(r.url(), "/auth/login") && r.request().method() === "POST", { timeout: 15_000 }),
    submit.click(),
  ]);
  const user: unknown = await response.json().catch(() => null);
  if (!response.ok() || !user || typeof user !== "object" || !("id" in user) ||
      !/^[1-9]\d*$/.test(String(user.id)) || ("phone_verification_required" in user && user.phone_verification_required)) {
    throw new Error("Pakakumi did not confirm login. Check the account or complete phone verification on Pakakumi.");
  }
  await page.waitForURL(url => url.pathname !== "/login" && url.pathname !== "/verify", { timeout: 10_000 });
  return String(user.id);
}

export async function loginPakakumi(page: Page, phone: string, password: string) {
  try { return await submitLogin(page, phone, password); }
  catch {
    // Playwright's fill errors can include the supplied value in their call log.
    throw new Error("Pakakumi login could not be confirmed. Check the account, phone verification and source availability.");
  }
}

export function accountBalance(payload: unknown): number {
  if (!payload || typeof payload !== "object" || !("accounts" in payload) || !Array.isArray(payload.accounts)) {
    throw new Error("Pakakumi did not provide a readable account balance");
  }
  const account = payload.accounts.find(a => a?.currency === "KES");
  if (!account || !Array.isArray(account.wallets) || account.wallets.length === 0) {
    throw new Error("Pakakumi did not provide the KES wallets");
  }
  // Match the game's available-balance calculation. It includes free-bet/bonus
  // wallets, so this figure is playable balance, not a withdrawal entitlement.
  let balance = 0;
  for (const wallet of account.wallets) {
    if (typeof wallet.balance !== "number" || !Number.isFinite(wallet.balance)) {
      throw new Error("Pakakumi returned an invalid wallet balance");
    }
    balance += Math.max(0, wallet.balance);
  }
  return Math.round(balance * 100) / 100;
}

export async function checkPakakumiBalance(page: Page, phone: string, password: string) {
  // The page requests these wallets itself after confirmed login. Observe that
  // reply rather than repeatedly querying the provider or reading a hydrated 0.
  const balanceReply = page.waitForResponse(r => sourceResponse(r.url(), "/accounts/me") && r.request().method() === "GET", { timeout: 28_000 });
  // Attach a rejection handler immediately if login fails before this resolves.
  void balanceReply.catch(() => undefined);
  await loginPakakumi(page, phone, password);
  const response = await balanceReply;
  if (!response.ok()) throw new Error("Pakakumi could not load the account balance");
  return accountBalance(await response.json());
}

export interface ProviderRound {
  bust: number;
  roundKey: string;
  bustId: string;
  settlement: { gameId: string; amount: number; grossPayout: number } | null;
}

// Observe the event bus already used by Pakakumi's current page. This adapter
// never sends game events or creates a second connection. Unknown layouts and
// lost connections stop execution instead of inferring financial outcomes.
const INSTALL_GAME_OBSERVER = String.raw`(async () => {
  const { userId, binding } = window.__pakakumiAdapterConfig;
  const script = Array.from(document.scripts).find(s => s.type === 'module' && s.src && new URL(s.src).origin === location.origin);
  if (!script) throw new Error('Pakakumi application module was not found');
  const module = await import(script.src);
  const buses = Object.values(module).filter(v => v && typeof v.on === 'function' && typeof v.off === 'function' && typeof v.emit === 'function' && typeof v.reconnect === 'function');
  if (buses.length !== 1) throw new Error('Pakakumi game event interface has changed');
  const socket = buses[0];
  const listeners = [];
  const on = (event, callback) => { listeners.push([event, callback]); socket.on(event, callback); };
  const state = window.__pakakumiGame = { phase: 'unknown', waitingAt: 0, ownBet: null, lastRound: null, failed: false, heardAt: Date.now() };
  const originalEmit = socket.emit;
  if (Object.getOwnPropertyDescriptor(socket, 'emit')?.writable !== true) throw new Error('Pakakumi request confirmation interface has changed');
  // Observe acknowledgements of the page's own UI request. A broadcast for the
  // same account from another browser is not proof that this click placed a bet.
  const observedEmit = (...args) => {
    const pending = state.submission;
    const request = args[1];
    if (args[0] === '1506' && pending?.active && request?.idx === 0 &&
        request.amount === pending.amount && request.autoCashout === pending.cashout && request.currency === 'KES') {
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        pending.sent = true;
        args[args.length - 1] = result => {
          pending.acknowledged = true;
          pending.accepted = !result?.error;
          return callback(result);
        };
      }
    }
    return originalEmit.apply(socket, args);
  };
  socket.emit = observedEmit;
  const send = payload => Promise.resolve(window[binding](payload)).catch(() => {});
  const fail = () => {
    if (state.failed) return;
    state.failed = true; state.phase = 'unknown';
    send({ error: 'Pakakumi connection or game updates were lost; check the last bet on Pakakumi before restarting.' });
  };
  const ownPlay = play => {
    if (!play || String(play.user_id) !== userId || Number(play.idx) !== 0) return;
    if (play.currency !== 'KES') return fail();
    if (play.game_id == null || !Number.isFinite(play.bet) || play.bet <= 0) return fail();
    const previous = state.ownBet?.gameId === String(play.game_id) ? state.ownBet : null;
    state.ownBet = { gameId: String(play.game_id), amount: play.bet, stoppedAt: play.stopped_at ?? previous?.stoppedAt ?? null };
  };
  on('disconnect', fail);
  on('1501', () => { if (!state.failed) { state.phase = 'waiting'; state.waitingAt = state.heardAt = Date.now(); } });
  on('1502', () => { state.phase = 'playing'; state.heardAt = Date.now(); });
  on('1503', () => { state.heardAt = Date.now(); });
  on('1506', ownPlay);
  on('1507', batch => { if (Array.isArray(batch?.plays)) batch.plays.forEach(ownPlay); });
  on('1505', payouts => {
    const stoppedAt = payouts?.[userId]?.[0];
    if (stoppedAt != null && state.ownBet) {
      if (!Number.isFinite(stoppedAt) || stoppedAt < 1) return fail();
      state.ownBet.stoppedAt = stoppedAt;
    }
  });
  on('1504', round => {
    if (state.failed) return;
    state.heardAt = Date.now();
    state.phase = 'busted';
    if (!round || round.gameId == null || !Number.isFinite(round.gameCrash) || round.gameCrash < 1) return fail();
    const gameId = String(round.gameId);
    if (state.lastRound === gameId) return;
    state.lastRound = gameId;
    const own = state.ownBet?.gameId === gameId ? state.ownBet : null;
    const stoppedAt = own?.stoppedAt;
    // A forced termination can involve cancellation/refund rules. Missing a
    // cashout in that case is not sufficient evidence of a lost stake.
    if (round.forced === true && own && stoppedAt == null) return fail();
    if (stoppedAt != null && (!Number.isFinite(stoppedAt) || stoppedAt < 1)) return fail();
    send({ bust: round.gameCrash, roundKey: gameId, bustId: '', settlement: own ? {
      gameId, amount: own.amount, grossPayout: own.amount * (stoppedAt ?? 0)
    } : null });
  });
  // A live connection can still stop supplying game updates during maintenance.
  // This is an in-page timer; it makes no network or database requests.
  const timer = setInterval(() => { if (Date.now() - state.heardAt >= 300000) fail(); }, 15000);
  window.__pakakumiCleanup = () => {
    state.failed = true;
    clearInterval(timer);
    listeners.forEach(([event, callback]) => socket.off(event, callback));
    if (socket.emit === observedEmit) socket.emit = originalEmit;
  };
  return true;
})()`;

export class PakakumiGamePage {
  private limits: { min: number; max: number } | null = null;
  private configReply: Promise<void> | null = null;
  private disposed = false;
  private failed = false;
  private observing = false;
  private onFailure: ((error: Error) => void) | null = null;
  private onNavigation = (frame: Frame) => {
    if (frame === this.page.mainFrame()) this.fail(new Error("Pakakumi reloaded or navigated away; check the last bet before restarting."));
  };
  private onPageLoss = () => this.fail(new Error("Pakakumi browser page was closed or crashed; check the last bet before restarting."));
  private onResponse = (response: Response) => {
    if (this.disposed || !sourceResponse(response.url(), "/config") || !response.ok()) return;
    this.configReply = response.json().then(config => {
      const min = config["crash.min_wager"], max = config["crash.max_wager"];
      this.limits = config.currency === "KES" && Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min ? { min, max } : null;
    }).catch(() => { this.limits = null; });
  };

  constructor(private page: Page) {
    page.on("response", this.onResponse);
  }

  private fail(error: Error) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    try { void Promise.resolve(this.onFailure?.(error)).catch(() => console.error("Pakakumi failure handler could not finish")); }
    catch { console.error("Pakakumi failure handler could not finish"); }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.page.off("response", this.onResponse);
    this.page.off("framenavigated", this.onNavigation);
    this.page.off("close", this.onPageLoss);
    this.page.off("crash", this.onPageLoss);
    if (this.observing && !this.page.isClosed()) {
      await deadline(this.page.evaluate("window.__pakakumiCleanup?.()"), 1000, "Observer cleanup timed out").catch(() => undefined);
    }
  }

  async observe(userId: string, onRound: (round: ProviderRound) => Promise<void>, onError: (error: Error) => void) {
    if (this.observing || this.disposed) throw new Error("Pakakumi observer is already attached or disposed");
    await this.page.getByLabel("Amount", { exact: true }).waitFor({ timeout: 20_000 });
    this.observing = true;
    this.onFailure = onError;
    this.page.on("framenavigated", this.onNavigation);
    this.page.on("close", this.onPageLoss);
    this.page.on("crash", this.onPageLoss);
    const binding = "__pakakumiProviderRound";
    await this.page.exposeFunction(binding, async (payload: ProviderRound & { error?: string }) => {
      if (this.disposed || this.failed) return;
      if (payload.error) return this.fail(new Error(payload.error));
      try { await onRound(payload); } catch (error) { this.fail(error instanceof Error ? error : new Error("Round processing failed")); }
    });
    await this.page.evaluate(({ userId, binding }) => {
      (window as unknown as { __pakakumiAdapterConfig: unknown }).__pakakumiAdapterConfig = { userId, binding };
    }, { userId, binding });
    await deadline(this.page.evaluate(INSTALL_GAME_OBSERVER), 10_000, "Pakakumi game interface did not initialize");
    if (this.configReply) await deadline(this.configReply, 10_000, "Pakakumi game limits did not load");
    if (this.failed || this.disposed) throw new Error("Pakakumi game observation was interrupted");
  }

  async phase(): Promise<"waiting" | "playing" | "busted" | "unknown"> {
    if (this.failed || this.disposed) return "unknown";
    return deadline(this.page.evaluate(String.raw`(() => {
      const state = window.__pakakumiGame;
      if (!state || state.failed || (state.phase === 'waiting' && Date.now() - state.waitingAt >= 5000)) return 'unknown';
      return state.phase;
    })()`), 2500, "Pakakumi page stopped responding");
  }

  async placeBet(amount: number, cashout: number, beforeSubmit?: () => Promise<boolean>) {
    if (this.failed || this.disposed) throw new Error("Pakakumi game observation is unavailable; no bet was submitted");
    if (!Number.isFinite(amount) || !Number.isFinite(cashout) || cashout < 1.01 || cashout > 3000) {
      throw new Error("Bet cashout must be between 1.01x and the published 3000x game limit");
    }
    // Observe the configuration the page loaded, without another request.
    const limits = this.limits;
    if (!limits || !Number.isFinite(limits.min) || !Number.isFinite(limits.max) || limits.min <= 0 || limits.max < limits.min) {
      throw new Error("Pakakumi stake limits could not be verified; no bet was submitted");
    }
    if (amount < limits.min || amount > limits.max) {
      throw new Error(`Bet amount must be between ${limits.min} and ${limits.max} KES`);
    }
    const amountInput = this.page.getByLabel("Amount", { exact: true });
    const cashoutInput = this.page.getByLabel("Auto Cashout (X)", { exact: true });
    await amountInput.fill(String(amount), { timeout: 2000 });
    await cashoutInput.fill(String(cashout), { timeout: 2000 });
    await cashoutInput.blur({ timeout: 1000 });
    if (Number(await amountInput.inputValue()) !== amount || Number(await cashoutInput.inputValue()) !== cashout) {
      throw new Error("Pakakumi changed the requested bet values; no bet was submitted");
    }
    if (beforeSubmit && !await beforeSubmit()) throw new Error("Session was stopped before submission; no bet was submitted");
    if (this.failed || this.disposed) throw new Error("Pakakumi observation ended before submission; no bet was submitted");
    if (await this.phase() !== "waiting") throw new Error("Betting window closed before submission");
    const before = await this.page.evaluate(String.raw`window.__pakakumiGame.ownBet?.gameId ?? null`) as string | null;
    await this.page.evaluate(({ amount, cashout }) => {
      (window as any).__pakakumiGame.submission = { amount, cashout, active: true, sent: false, acknowledged: false, accepted: false };
    }, { amount, cashout });
    try {
      await this.page.getByRole("button", { name: /^bet$/i }).click({ timeout: 1500 });
      const accepted = await this.page.waitForFunction(({ before, amount }) => {
        const state = (window as any).__pakakumiGame;
        return state && !state.failed && state.submission?.sent && state.submission.accepted &&
          state.ownBet && state.ownBet.gameId !== before && state.ownBet.amount === amount ? state.ownBet : null;
      }, { before, amount }, { timeout: 2500 });
      const bet = await accepted.jsonValue() as { gameId: string; amount: number };
      await accepted.dispose();
      return bet.gameId;
    } catch {
      throw new Error("Bet submission could not be confirmed; check the last bet on Pakakumi before restarting");
    } finally {
      if (!this.page.isClosed()) await deadline(this.page.evaluate("if (window.__pakakumiGame?.submission) window.__pakakumiGame.submission.active = false"), 1000, "Confirmation cleanup timed out").catch(() => undefined);
    }
  }
}
