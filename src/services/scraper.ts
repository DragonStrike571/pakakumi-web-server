import { chromium, Page, Browser } from "playwright";
import { EventEmitter } from "events";
import { config } from "dotenv";
import { trycatch } from "../utils/try-catch.js";

config();

const PAKAKUMI_URL = process.env.PAKAKUMI_URL || "https://play.pakakumi.com";

export interface RoundData {
  bust: number;
  bustId: string;
  playersOnline: number;
  playersPlaying: number;
  totalAmountPlayed: number;
  totalAmountWon: number;
  totalAmountLost: number;
  averageAmountPlayed: number;
  maxAmountPlayed: number;
}

export class GameScraper extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isRunning: boolean = false;
  private previousBustIDs = new Set<string>();

  // Debounce: the observer can fire many times for one round change.
  // We collapse rapid signals into a single scrape after 100ms of quiet.
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scraping: boolean = false;

  constructor() {
    super();
  }

  public async start() {
    if (this.isRunning) {
      console.log("⚠️ Scraper is already running.");
      return;
    }

    console.log("🚀 Starting Game Scraper...");
    const { error } = await trycatch(async () => {
      this.browser = await chromium.launch({
        headless: process.env.HEADLESS !== "false",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      this.page = await this.browser.newPage();

      // Expose a lightweight signal function — NO data is sent from the browser,
      // this just tells Node that the DOM changed. Scraping happens Node-side.
      await this.page.exposeFunction("__onDomChanged", () => {
        this.scheduleScrape();
      });

      console.log("🌐 Navigating to game...");
      await this.page.goto(PAKAKUMI_URL, { waitUntil: "load" });

      // SKIPPED: // Configure settings to show more players
      // await this.configureGameSettings();

      // Attach MutationObserver that calls our signal function
      await this.setupObserver();

      // Initial scrape to populate previousBustIDs (no events emitted)
      await this.initialScrape();

      this.browser.on("disconnected", () => {
        console.error("❌ Browser disconnected! Attempting restart in 5s...");
        this.isRunning = false;
        this.clearDebounce();
        setTimeout(() => this.start(), 5000);
      });

      this.isRunning = true;
      console.log("✅ Scraper started and listening for rounds.");
    });

    if (error) {
      console.error("❌ Error starting scraper:", error);
      this.stop();
      setTimeout(() => this.start(), 10000);
    }
  }

  public async stop() {
    this.clearDebounce();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
    this.isRunning = false;
    console.log("🛑 Scraper stopped.");
  }

  // ---------------------------------------------------------------------------
  // Event-driven signal handling
  // ---------------------------------------------------------------------------

  /**
   * Called by the browser's MutationObserver via exposeFunction.
   * Debounces rapid-fire mutations into a single scrape after 100ms of quiet.
   */
  private scheduleScrape() {
    // If we're already mid-scrape, just mark that another change came in
    // (the current scrape will pick it up since it reads the latest DOM state)
    if (this.scraping) return;

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

    await this.page.evaluate(() => {
      const targetNode = document.querySelector("table.css-1a87jyo tbody");
      if (!targetNode) {
        console.error("❌ Target Node not found!");
        setTimeout(() => window.location.reload(), 5000);
        return;
      }

      const observer = new MutationObserver(() => {
        (window as any).__onDomChanged();
      });
      observer.observe(targetNode, { childList: true, subtree: true });
      console.log("📡 DOM change observer attached.");
    });
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
      console.error("❌ Error scraping data:", (error as any).message);
      return null;
    }
  }

  private async checkForChanges() {
    const data = await this.scrapeGameData();
    if (!data || data.busts.length === 0) return;

    const newBusts: { bust: number; id: string }[] = [];

    for (let i = 0; i < Math.min(data.busts.length, 30); i++) {
      const bustID = this.generateBustID(data.busts, i);
      if (!this.previousBustIDs.has(bustID)) {
        newBusts.push({ bust: data.busts[i], id: bustID });
        this.previousBustIDs.add(bustID);
      }
    }

    if (newBusts.length === 0) return;

    for (const item of newBusts.reverse()) {
      const roundData: RoundData = {
        bust: item.bust,
        bustId: item.id,
        playersOnline: data.onlineCount,
        playersPlaying: data.playingCount,
        totalAmountPlayed: data.totalCashPlayed,
        totalAmountWon: data.totalWinAmount,
        totalAmountLost: data.totalLossAmount,
        averageAmountPlayed: data.averageSpending,
        maxAmountPlayed: data.maxSpending,
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
