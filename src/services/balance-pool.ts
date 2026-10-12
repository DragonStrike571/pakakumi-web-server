import { chromium, type Browser, type BrowserContext } from "playwright";

export class BalancePool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private active = 0;
  private contexts = new Set<BrowserContext>();
  private stopped = false;
  private waiters: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void }[] = [];
  constructor(private launch: () => Promise<Browser> = () => chromium.launch({
    headless: process.env.HEADLESS !== "false", args: process.env.PLAYWRIGHT_DISABLE_SANDBOX === "true" ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  })) {}

  private async reserve(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Balance pool is closed");
    if (this.active < 4) { this.active++; return; }
    if (this.waiters.length >= 10) throw new Error("Balance service is busy; retry later");
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error("Balance request cancelled"));
      } };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  private free() {
    this.active = Math.max(0, this.active - 1);
    const waiter = this.waiters.shift();
    if (waiter) { waiter.signal?.removeEventListener("abort", waiter.abort); this.active++; waiter.resolve(); }
  }

  async getContext(signal?: AbortSignal): Promise<{ browser: Browser; context: BrowserContext }> {
    await this.reserve(signal);
    let assigned = false;
    try {
      if (!this.browser?.isConnected()) {
        if (!this.launching) this.launching = this.launch().then(browser => {
          this.browser = browser;
          browser.on("disconnected", () => { if (this.browser === browser) this.browser = null; });
          return browser;
        }).finally(() => { this.launching = null; });
        await this.launching;
      }
      signal?.throwIfAborted();
      if (this.stopped) throw new Error("Balance pool is closed");
      const browser = this.browser!;
      const context = await browser.newContext();
      this.contexts.add(context);
      assigned = true;
      const abort = () => { void this.releaseContext(context); };
      signal?.addEventListener("abort", abort, { once: true });
      context.once("close", () => {
        signal?.removeEventListener("abort", abort);
        if (this.contexts.delete(context)) this.free();
      });
      if (this.stopped || signal?.aborted) {
        await this.releaseContext(context);
        throw signal?.reason || new Error("Balance pool is closed");
      }
      return { browser, context };
    } catch (error) { if (!assigned) this.free(); throw error; }
  }

  async releaseContext(context: BrowserContext) {
    if (!this.contexts.has(context)) return;
    try { await context.close(); } catch (error) { console.error("Balance context close failed:", error); }
    finally { if (this.contexts.delete(context)) this.free(); }
  }

  async shutdown() {
    this.stopped = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error("Balance pool is closed"));
    }
    await this.launching?.catch(() => undefined);
    await Promise.allSettled([...this.contexts].map(context => this.releaseContext(context)));
    await this.browser?.close();
    this.browser = null;
  }
}
export const balancePool = new BalancePool();
