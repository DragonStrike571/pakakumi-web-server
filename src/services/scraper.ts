import { chromium, Page, Browser } from "playwright";
import { EventEmitter } from "events";
import { config } from "dotenv";
import { trycatch } from "../utils/try-catch.js";

config();

const PAKAKUMI_URL = process.env.PAKAKUMI_URL || "https://play.pakakumi.com";
const chromiumArgs = process.env.PLAYWRIGHT_DISABLE_SANDBOX === "true"
  ? ["--no-sandbox", "--disable-setuid-sandbox"]
  : [];

export interface RoundData {
  bust: number;
  bustId: string;
  playersOnline: number | null;
  playersPlaying: number | null;
  totalAmountPlayed: number | null;
  totalAmountWon: number | null;
  totalAmountLost: number | null;
  averageAmountPlayed: number | null;
  maxAmountPlayed: number | null;
  metricsComplete: boolean;
}

export class GameScraper extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isRunning: boolean = false;
  private previousBustIDs = new Set<string>();
  private restartCount: number = 0;
  private readonly MAX_RESTARTS = 10;
  private desiredRunning = false;
  private starting = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounce: the observer can fire many times for one round change.
  // We collapse rapid signals into a single scrape after 100ms of quiet.
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scraping: boolean = false;
  private scrapeQueued = false;

  // Staleness detection: if no DOM changes arrive for this long, re-initialize the observer
  private stalenessTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly STALENESS_TIMEOUT_MS = 300_000; // 5 minutes without a DOM change = stale
  private lastActivity: number = Date.now();
  private observerSetupFailures: number = 0;
  private readonly MAX_OBSERVER_FAILURES = 3;

  constructor() {
    super();
  }

  public getStatus() {
    return {
      running: this.isRunning,
      starting: this.starting,
      recovering: Boolean(this.restartTimer),
      restartCount: this.restartCount,
      lastActivityAt: new Date(this.lastActivity).toISOString(),
    };
  }

  public async start() {
    this.desiredRunning = true;
    if (this.isRunning || this.starting) {
      console.log("⚠️ Scraper is already running.");
      return;
    }

    this.starting = true;
    this.clearRestartTimer();
    console.log("🚀 Starting Game Scraper...");
    const { error } = await trycatch(async () => {
      const browser = await chromium.launch({
        headless: process.env.HEADLESS !== "false",
        args: chromiumArgs,
      });
      this.browser = browser;
      this.page = await browser.newPage();

      // Expose a lightweight signal function — NO data is sent from the browser,
      // this just tells Node that the DOM changed. Scraping happens Node-side.
      await this.page.exposeFunction("__onDomChanged", () => {
        this.scheduleScrape();
      });

      console.log("🌐 Navigating to game...");
      await this.page.goto(PAKAKUMI_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (!this.desiredRunning) throw new Error("Scraper start was cancelled");

      // SKIPPED: // Configure settings to show more players
      // await this.configureGameSettings();

      // Attach MutationObserver that calls our signal function
      await this.setupObserver();

      // Retain IDs across restarts so rounds that occurred during downtime can
      // be recovered instead of being silently accepted as a new baseline.
      if (this.previousBustIDs.size === 0) await this.initialScrape();
      else await this.checkForChanges();

      browser.on("disconnected", () => {
        if (this.browser === browser) {
          this.browser = null;
          this.page = null;
        }
        this.isRunning = false;
        this.clearDebounce();
        this.clearStalenessTimer();
        if (!this.desiredRunning) return;
        console.error("❌ Browser disconnected! Attempting restart in 5s...");
        this.scheduleRestart(5_000);
      });

      this.isRunning = true;
      this.clearStableTimer();
      this.stableTimer = setTimeout(() => {
        this.restartCount = 0;
        this.stableTimer = null;
      }, 10 * 60_000);
      this.lastActivity = Date.now();
      this.resetStalenessTimer();
      console.log("✅ Scraper started and listening for rounds.");
    });
    this.starting = false;

    if (error) {
      console.error("❌ Error starting scraper:", error);
      await this.closeBrowser();
      this.scheduleRestart(10_000);
    }
  }

  public async stop() {
    this.desiredRunning = false;
    this.isRunning = false;
    this.clearRestartTimer();
    this.clearStableTimer();
    this.clearDebounce();
    this.clearStalenessTimer();
    await this.closeBrowser();
    console.log("🛑 Scraper stopped.");
  }

  private async closeBrowser() {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.isRunning = false;
    if (!browser) return;
    browser.removeAllListeners("disconnected");
    await browser.close().catch((error) => {
      console.warn("Failed to close scraper browser cleanly:", error);
    });
  }

  private scheduleRestart(delayMs: number) {
    if (!this.desiredRunning || this.restartTimer) return;
    this.restartCount++;
    if (this.restartCount > this.MAX_RESTARTS) {
      this.desiredRunning = false;
      console.error("🛑 Scraper exceeded max restarts. Halting permanently.");
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delayMs);
  }

  private clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearStableTimer() {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private clearStalenessTimer() {
    if (this.stalenessTimer) {
      clearTimeout(this.stalenessTimer);
      this.stalenessTimer = null;
    }
  }

  private resetStalenessTimer() {
    this.clearStalenessTimer();
    this.stalenessTimer = setTimeout(() => {
      this.handleStaleness();
    }, this.STALENESS_TIMEOUT_MS);
  }

  private async handleStaleness() {
    const silentSeconds = Math.round((Date.now() - this.lastActivity) / 1000);
    console.warn(
      `⚠️ Scraper stale: no DOM changes for ${silentSeconds}s. Reloading page...`,
    );

    if (!this.page || !this.isRunning) return;

    try {
      await this.page.reload({ waitUntil: "load", timeout: 30000 });
      await this.setupObserver();
      this.lastActivity = Date.now();
      this.resetStalenessTimer();
      console.log("✅ Scraper re-initialized after staleness.");
    } catch (err) {
      console.error("❌ Failed to recover from staleness:", err);
      // Full restart only if observer keeps failing
      this.observerSetupFailures++;
      if (this.observerSetupFailures >= this.MAX_OBSERVER_FAILURES) {
        console.error("🛑 Observer setup failed too many times. Full browser restart...");
        this.clearStalenessTimer();
        this.observerSetupFailures = 0;
        await this.closeBrowser();
        this.scheduleRestart(5_000);
      } else {
        // Retry after a short delay instead of full restart
        this.resetStalenessTimer();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event-driven signal handling
  // ---------------------------------------------------------------------------

  /**
   * Called by the browser's MutationObserver via exposeFunction.
   * Debounces rapid-fire mutations into a single scrape after 100ms of quiet.
   */
  private scheduleScrape() {
    if (!this.desiredRunning) return;
    if (this.scraping) {
      this.scrapeQueued = true;
      return;
    }

    // Reset staleness timer on any activity
    this.lastActivity = Date.now();
    this.resetStalenessTimer();

    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.performScrape();
    }, 100);
  }

  private clearDebounce() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Debounced handler: scrapes the page and processes changes.
   * Runs entirely on the Node side via Playwright locators.
   */
  private async performScrape() {
    if (!this.page || !this.isRunning) return;

    this.scraping = true;
    try {
      await this.checkForChanges();
    } catch (err) {
      console.error("❌ Error during scrape:", err);
    } finally {
      this.scraping = false;
      if (this.scrapeQueued) {
        this.scrapeQueued = false;
        this.scheduleScrape();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /**
   * Configure game settings to show up to 3000 people.
   */
  private async configureGameSettings() {
    if (!this.page) return;

    try {
      console.log("⚙️ Opening settings...");
      await this.page.locator("div.css-1633bsf a button.css-1t9yabi").click();

      console.log("🛠️ Modifying settings to show up to 3000 people...");
      await this.page
        .locator(
          "div.css-1g3l8kd div.css-1633bsf div.css-1l95nvm input.css-10zyika",
        )
        .click();
      await this.page
        .locator(
          "div.css-1g3l8kd div.css-1633bsf div.css-1l95nvm input.css-10zyika",
        )
        .fill("3000");
      await this.page.locator("div.css-16j3z8f").click();
      console.log("✅ Settings configured.");
    } catch (err) {
      console.warn("⚠️ Could not configure settings (may have changed):", err);
    }
  }

  /**
   * Attach a MutationObserver in the browser that calls __onDomChanged().
   * The observer does NO scraping — it only signals Node that something changed.
   */
  private async setupObserver() {
    if (!this.page) return;

    await this.page
      .locator("table.css-1a87jyo tbody")
      .first()
      .waitFor({ state: "attached", timeout: 30_000 });
    const attached = await this.page.evaluate(() => {
      const targetNode = document.querySelector("table.css-1a87jyo tbody");
      if (!targetNode) return false;

      (window as any).__pakakumiObserver?.disconnect();
      const observer = new MutationObserver(() => {
        (window as any).__onDomChanged();
      });
      observer.observe(targetNode, { childList: true, subtree: true });
      (window as any).__pakakumiObserver = observer;
      console.log("📡 DOM change observer attached.");
      return true;
    });
    if (!attached) throw new Error("Pakakumi round-history table was not found");

    // Reset observer failure counter on successful attach
    this.observerSetupFailures = 0;
  }

  /**
   * Initial scrape to populate previousBustIDs without emitting events.
   */
  private async initialScrape() {
    if (!this.page) return;

    console.log("🔍 Initial scrape...");
    const data = await this.scrapeGameData();
    if (!data) return;

    for (let i = 0; i < Math.min(data.busts.length, 40); i++) {
      const bustID = this.generateBustID(data.busts, i);
      this.previousBustIDs.add(bustID);
    }

    console.log(
      `✅ Initial scrape complete. Tracking ${this.previousBustIDs.size} bust IDs.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Scraping (always runs Node-side via Playwright locators)
  // ---------------------------------------------------------------------------

  private async scrapeGameData() {
    if (!this.page) return null;

    try {
      const bustElements = await this.page
        .locator("table.css-1a87jyo tbody tr.css-15iar3s td span.css-hwpcld")
        .allInnerTexts();
      const busts = bustElements
        .map((text) => parseFloat(text.replace("x", "").replace(",", "")))
        .slice(0, 40);

      const onlineCountStr = await this.page
        .locator("(//div[contains(@class, 'css-eb3kfa')]//strong)[1]")
        .innerText();
      const playingCountStr = await this.page
        .locator("(//div[contains(@class, 'css-eb3kfa')]//strong)[2]")
        .innerText();

      const amountElements = await this.page
        .locator("div.css-afms4i table.css-1a87jyo tbody tr td:nth-child(3)")
        .allInnerTexts();
      const profitElements = await this.page
        .locator("div.css-afms4i table.css-1a87jyo tbody tr td:nth-child(4)")
        .allInnerTexts();

      const amounts = amountElements.map((text) =>
        parseFloat(text.replace(/,/g, "")),
      );
      const profits = profitElements.map((text) =>
        parseFloat(text.replace(/,/g, "")),
      );

      const totalCashPlayed = amounts.reduce((sum, val) => sum + val, 0);
      const totalWinAmount = profits
        .filter((val) => val > 0)
        .reduce((sum, val) => sum + val, 0);
      const totalLossAmount = profits
        .filter((val) => val < 0)
        .reduce((sum, val) => sum + Math.abs(val), 0);

      const playingCount = parseInt(playingCountStr.replace(/,/g, ""));
      const averageSpending =
        playingCount > 0 ? totalCashPlayed / playingCount : 0;
      const maxSpending = amounts.length > 0 ? Math.max(...amounts) : 0;

      return {
        busts,
        onlineCount: parseInt(onlineCountStr.replace(/,/g, "")),
        playingCount,
        totalCashPlayed,
        totalWinAmount,
        totalLossAmount,
        averageSpending,
        maxSpending,
      };
    } catch (error) {
      console.error(
        "❌ Error scraping data:",
        error instanceof Error ? error.message : "Unknown scraper error",
      );
      return null;
    }
  }

  private async checkForChanges() {
    const data = await this.scrapeGameData();
    if (!data || data.busts.length === 0) return;

    const newBusts: { bust: number; id: string; sourceIndex: number }[] = [];

    for (let i = 0; i < Math.min(data.busts.length, 30); i++) {
      const bustID = this.generateBustID(data.busts, i);
      if (!this.previousBustIDs.has(bustID)) {
        newBusts.push({ bust: data.busts[i], id: bustID, sourceIndex: i });
        this.previousBustIDs.add(bustID);
      }
    }

    if (newBusts.length === 0) return;

    for (const item of newBusts.reverse()) {
      // Player/financial values on the page belong only to the newest round.
      // Preserve recovered bust history without fabricating metrics for older
      // rounds that appeared while the scraper was disconnected or busy.
      const metricsComplete = item.sourceIndex === 0;
      const roundData: RoundData = {
        bust: item.bust,
        bustId: item.id,
        playersOnline: metricsComplete ? data.onlineCount : null,
        playersPlaying: metricsComplete ? data.playingCount : null,
        totalAmountPlayed: metricsComplete ? data.totalCashPlayed : null,
        totalAmountWon: metricsComplete ? data.totalWinAmount : null,
        totalAmountLost: metricsComplete ? data.totalLossAmount : null,
        averageAmountPlayed: metricsComplete ? data.averageSpending : null,
        maxAmountPlayed: metricsComplete ? data.maxSpending : null,
        metricsComplete,
      };

      this.emit("roundEnded", roundData);
      console.log(
        `📡 Emitted roundEnded: ${item.bust}x (ID: ${item.id.substring(0, 10)}...)`,
      );
    }

    // Prune Set to prevent memory leak
    if (this.previousBustIDs.size > 1000) {
      this.previousBustIDs.clear();
      for (let i = 0; i < Math.min(data.busts.length, 40); i++) {
        const id = this.generateBustID(data.busts, i);
        this.previousBustIDs.add(id);
      }
      console.log("🧹 Pruned previousBustIDs cache.");
    }
  }

  private generateBustID(busts: number[], index: number): string {
    return busts.slice(index, index + 10).join("-");
  }
}

export const gameScraper = new GameScraper();
