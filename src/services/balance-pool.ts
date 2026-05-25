import { chromium, Browser, BrowserContext, Page } from "playwright";
import { trycatch } from "../utils/try-catch.js";

const MAX_BROWSERS = 2;

class BalancePool {
  private browsers: Browser[] = [];
  private activeContexts: number = 0;

  async getContext(): Promise<{ browser: Browser; context: BrowserContext }> {
    let browserToUse: Browser | null = null;

    // First try to find an existing browser that we can reuse
    if (this.browsers.length > 0) {
      // Pick the browser with the least number of contexts (simplistic load balancing)
      // Actually, Playwright handles multiple contexts on one browser very well.
      // We will just use the first browser if it's available, or round-robin it.
      browserToUse = this.browsers[this.activeContexts % this.browsers.length];
    } else if (this.browsers.length < MAX_BROWSERS) {
      // Launch a new browser if we haven't hit the limit
      console.log("[BalancePool] Launching new browser instance...");
      const { data: browser, error } = await trycatch(async () => {
        return await chromium.launch({
          headless: process.env.HEADLESS !== "false",
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
      });
      if (error || !browser) {
        throw error || new Error("Failed to launch balance pool browser");
      }
      this.browsers.push(browser);
      browserToUse = browser;
    } else {
      // Wait or just use the first one if we hit the limit
      // Since contexts are lightweight, we can share the existing browsers.
      browserToUse = this.browsers[this.activeContexts % this.browsers.length];
    }

    this.activeContexts++;
    const context = await browserToUse.newContext();
    return { browser: browserToUse, context };
  }

  async releaseContext(context: BrowserContext) {
    await trycatch(async () => await context.close());
    this.activeContexts = Math.max(0, this.activeContexts - 1);
  }

  async shutdown() {
    for (const browser of this.browsers) {
      await trycatch(async () => await browser.close());
    }
    this.browsers = [];
    this.activeContexts = 0;
  }
}

export const balancePool = new BalancePool();
