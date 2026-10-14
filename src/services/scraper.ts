import { chromium, Page, Browser } from "playwright";
import { EventEmitter } from "events";
import { config } from "dotenv";
import { trycatch } from "../utils/try-catch.js";
import { runBackgroundTask } from "../utils/background-task.js";
import { GAME_SOURCE_READER, type GameSourceSnapshot } from "./game-source-dom.js";

config();

const PAKAKUMI_URL = process.env.PAKAKUMI_URL || "https://pakakumi.com/crash";
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
  sourceGap?: boolean;
}

class CaptureFailure extends Error {}
class SourceUnavailable extends Error {}
type ScraperOptions = {
  now?: () => number;
  launch?: () => Promise<Browser>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  staleAfterMs?: number;
  pollMs?: number;
  readTimeoutMs?: number;
};

export class GameScraper extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isRunning: boolean = false;
  private checkpoint: string | null = null;
  private capture: ((batch: RoundData[], checkpoint: string) => Promise<void>) | null = null;
  private restartCount: number = 0;
  private desiredRunning = false;
  private starting = false;
  private captureError: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRetryAt: number | null = null;
  private outageSince: number | null = null;
  private lastRoundAt: number | null = null;
  private lastHistoryAt: number | null = null;
  private failureKind: "source" | "capture" | null = null;
  private startedAt = 0;
  private readonly now: () => number;
  private readonly launch: () => Promise<Browser>;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly staleAfterMs: number;
  private readonly pollMs: number;
  private readonly readTimeoutMs: number;

  // Debounce: the observer can fire many times for one round change.
  // We collapse rapid signals into a single scrape after 100ms of quiet.
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scraping: boolean = false;
  private scrapeQueued = false;

  // Probe source history even if page animations keep firing DOM mutations.
  private stalenessTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity: number = Date.now();

  constructor(options: ScraperOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.launch = options.launch ?? (() => chromium.launch({ headless: process.env.HEADLESS !== "false", args: chromiumArgs }));
    this.retryBaseMs = options.retryBaseMs ?? 10_000;
    // Keep recovery latency below the provider's small visible history window.
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    this.pollMs = options.pollMs ?? 30_000;
    this.readTimeoutMs = options.readTimeoutMs ?? 15_000;
    this.lastActivity = this.now();
  }

  public setCaptureHandler(checkpoint: string | null, capture: (batch: RoundData[], checkpoint: string) => Promise<void>, lastRoundAt?: string | null) {
    this.checkpoint = checkpoint;
    this.capture = capture;
    if (lastRoundAt && Number.isFinite(Date.parse(lastRoundAt))) this.lastRoundAt = Date.parse(lastRoundAt);
  }

  public getStatus() {
    const fresh = this.lastRoundAt !== null && this.now() - this.lastRoundAt < this.staleAfterMs;
    const healthy = this.isRunning && fresh && this.captureError === null;
    const sourceStatus = healthy || this.failureKind === "capture" && this.lastHistoryAt !== null && this.now() - this.lastHistoryAt < this.staleAfterMs
      ? "available" : this.isRunning ? "waiting" : !this.desiredRunning ? "stopped" : this.starting && this.outageSince === null ? "checking" : "unavailable";
    return {
      healthy,
      sourceStatus,
      running: this.isRunning,
      starting: this.starting,
      recovering: Boolean(this.restartTimer),
      restartCount: this.restartCount,
      captureError: this.captureError,
      failureKind: this.failureKind,
      lastRoundAt: this.lastRoundAt === null ? null : new Date(this.lastRoundAt).toISOString(),
      lastHistoryAt: this.lastHistoryAt === null ? null : new Date(this.lastHistoryAt).toISOString(),
      outageSince: this.outageSince === null ? null : new Date(this.outageSince).toISOString(),
      nextRetryAt: this.nextRetryAt === null ? null : new Date(this.nextRetryAt).toISOString(),
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
    this.startedAt = this.now();
    this.clearRestartTimer();
    console.log("🚀 Starting Game Scraper...");
    const { error } = await trycatch(async () => {
      const browser = await this.launch();
      this.browser = browser;
      if (!this.desiredRunning) throw new Error("Scraper start was cancelled");
      browser.on("disconnected", () => {
        if (this.browser !== browser) return;
        this.browser = null; this.page = null; this.isRunning = false;
        this.clearDebounce(); this.clearStalenessTimer();
        if (!this.desiredRunning) return;
        this.recordFailure(new Error("Scraper browser disconnected"));
        this.scheduleRestart(this.retryBaseMs);
      });
      this.page = await browser.newPage();

      // Expose a lightweight signal function — NO data is sent from the browser,
      // this just tells Node that the DOM changed. Scraping happens Node-side.
      await this.page.exposeFunction("__onDomChanged", () => {
        this.scheduleScrape();
      });

      console.log("🌐 Navigating to game...");
      const response = await this.page.goto(PAKAKUMI_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (response && response.status() >= 400) throw new SourceUnavailable(`Pakakumi returned HTTP ${response.status()}; collection is waiting for the source to recover`);
      if (!this.desiredRunning) throw new Error("Scraper start was cancelled");

      // Attach MutationObserver that calls our signal function
      await this.setupObserver();

      // Retain IDs across restarts so rounds that occurred during downtime can
      // be recovered instead of being silently accepted as a new baseline.
      await this.checkForChanges();

      if (!this.desiredRunning || this.browser !== browser) throw new Error("Scraper start was cancelled or the browser disconnected");
      this.isRunning = true;
      this.lastActivity = this.now();
      this.resetStalenessTimer();
      console.log("✅ Scraper started and listening for rounds.");
    });
    this.starting = false;

    if (error) {
      if (this.desiredRunning) this.recordFailure(error);
      if (error instanceof SourceUnavailable) console.warn(`Collection source unavailable: ${error.message}`);
      else console.error("❌ Error starting scraper:", error);
      await this.closeBrowser();
      this.scheduleRestart(this.retryBaseMs);
    }
  }

  public async stop() {
    this.desiredRunning = false;
    this.isRunning = false;
    this.clearRestartTimer();
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
    // The identity guard already ignores our callback for this detached browser.
    // Playwright's own disconnected listener resolves browser.close(); keep it.
    await browser.close().catch((error) => {
      console.warn("Failed to close scraper browser cleanly:", error);
    });
  }

  private scheduleRestart(delayMs: number) {
    if (!this.desiredRunning || this.restartTimer) return;
    this.restartCount++;
    delayMs = Math.min(this.retryMaxMs, delayMs * 2 ** Math.min(this.restartCount - 1, 20));
    this.nextRetryAt = this.now() + delayMs;
    console.warn(`Collection will retry in ${Math.ceil(delayMs / 1000)} seconds; saved checkpoints are retained.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.nextRetryAt = null;
      runBackgroundTask("Scraper restart", () => this.start());
    }, delayMs);
  }

  private clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.nextRetryAt = null;
  }

  private recordFailure(error: unknown) {
    this.captureError = error instanceof Error ? error.message : String(error);
    this.failureKind = error instanceof CaptureFailure ? "capture" : "source";
    if (this.failureKind === "source" && this.outageSince === null) this.outageSince = this.now();
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
      this.stalenessTimer = null;
      runBackgroundTask("Scraper source probe", async () => {
        await this.performScrape();
        if (this.isRunning && this.desiredRunning) this.resetStalenessTimer();
      });
    }, this.pollMs);
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

    // DOM animations are not evidence of new rounds; the source probe runs independently.
    this.lastActivity = this.now();

    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      runBackgroundTask("Scraper polling", () => this.performScrape());
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
    if (this.scraping) { this.scrapeQueued = true; return; }
    const page = this.page;

    this.scraping = true;
    try {
      await this.checkForChanges();
      if (this.page !== page || !this.desiredRunning) return;
      if (this.now() - (this.lastRoundAt ?? this.startedAt) >= this.staleAfterMs) throw new Error("Pakakumi round history is paused or stale; waiting for new rounds");
    } catch (err) {
      if (this.page !== page || !this.desiredRunning) return;
      this.recordFailure(err);
      console.error("❌ Error during scrape:", err);
      if (!(err instanceof CaptureFailure)) {
        this.clearDebounce(); this.clearStalenessTimer();
        await this.closeBrowser();
        this.scheduleRestart(this.retryBaseMs);
      }
    } finally {
      this.scraping = false;
      const queued = this.scrapeQueued;
      this.scrapeQueued = false;
      if (queued && this.isRunning) {
        this.scheduleScrape();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /**
   * Attach a MutationObserver in the browser that calls __onDomChanged().
   * The observer does NO scraping — it only signals Node that something changed.
   */
  private async setupObserver() {
    if (!this.page) return;
    try {
      const ready = await this.page.waitForFunction(GAME_SOURCE_READER, undefined, { timeout: 30_000, polling: 1000 });
      await ready.dispose();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new SourceUnavailable("Pakakumi crash history is not ready after 30 seconds; the page may be loading, under maintenance, or have a new layout");
      }
      throw error;
    }
  }

  /**
   * Initial scrape to populate previousBustIDs without emitting events.
   */
  private async initialScrape() {
    await this.checkForChanges();
  }

  // ---------------------------------------------------------------------------
  // Scraping (always runs Node-side via Playwright locators)
  // ---------------------------------------------------------------------------

  private async scrapeGameData() {
    if (!this.page) return null;

    try {
      // One browser task reads a coherent DOM snapshot, including financial rows.
      const observation = this.page.evaluate(GAME_SOURCE_READER) as Promise<GameSourceSnapshot | null>;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const snapshot = await Promise.race([observation, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Pakakumi history read timed out")), this.readTimeoutMs);
      })]).finally(() => clearTimeout(deadline));
      if (!snapshot) throw new SourceUnavailable("Pakakumi crash history is missing or ambiguous");
      const bustElements = snapshot.busts;
      const busts = bustElements
        .map((text) => Number(text.trim().replace(/[x×\s,]/gi, "")))
        .slice(0, 40);
      if (busts.some(b => !Number.isFinite(b) || b < 1)) throw new Error("Invalid bust history");

      const onlineCountStr = snapshot.counts[0] || "";
      const playingCountStr = snapshot.counts[1] || "";

      const amountElements = snapshot.amounts;
      const profitElements = snapshot.profits;

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

      const playingCount = Number(playingCountStr.replace(/,/g, ""));
      const averageSpending =
        playingCount > 0 ? totalCashPlayed / playingCount : 0;
      const maxSpending = amounts.length > 0 ? Math.max(...amounts) : 0;
      const onlineCount = Number(onlineCountStr.replace(/,/g, ""));
      const countsComplete = [onlineCountStr, playingCountStr].every(text => /^\d+(?:,\d{3})*$/.test(text.trim())) &&
        [onlineCount, playingCount].every(number => Number.isSafeInteger(number) && number >= 0) && onlineCount >= playingCount;
      const metricsComplete = amountElements.length > 0 && amounts.length === profits.length &&
        amounts.length === playingCount && playingCountStr.trim() !== "" && Number.isSafeInteger(playingCount) && playingCount >= 0 &&
        onlineCountStr.trim() !== "" && Number.isSafeInteger(onlineCount) && onlineCount >= playingCount &&
        amounts.every(n => Number.isFinite(n) && n >= 0) && profits.every(Number.isFinite);

      return {
        busts,
        onlineCount,
        playingCount,
        totalCashPlayed,
        totalWinAmount,
        totalLossAmount,
        averageSpending,
        maxSpending,
        metricsComplete,
        countsComplete,
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
    const page = this.page;
    const data = await this.scrapeGameData();
    if (this.page !== page) return;
    if (!data || data.busts.length < 10) throw new Error("Round history is unavailable or incomplete");
    this.lastHistoryAt = this.now();

    const newBusts: { bust: number; id: string; sourceIndex: number }[] = [];

    const available = Math.min(Math.max(0, data.busts.length - 9), 31);
    const anchor = this.checkpoint === null ? -1 : Array.from({ length: available }, (_, i) => this.generateBustID(data.busts, i)).indexOf(this.checkpoint);
    const count = anchor >= 0 ? anchor : available;
    for (let i = 0; i < count; i++) {
      const bustID = this.generateBustID(data.busts, i);
      newBusts.push({ bust: data.busts[i], id: bustID, sourceIndex: i });
    }

    if (newBusts.length === 0) return;

    const batch: RoundData[] = [];
    for (const item of newBusts.reverse()) {
      // Player/financial values on the page belong only to the newest round.
      // Preserve recovered bust history without fabricating metrics for older
      // rounds that appeared while the scraper was disconnected or busy.
      const metricsComplete = item.sourceIndex === 0 && data.metricsComplete;
      const roundData: RoundData = {
        bust: item.bust,
        bustId: item.id,
        playersOnline: item.sourceIndex === 0 && data.countsComplete ? data.onlineCount : null,
        playersPlaying: item.sourceIndex === 0 && data.countsComplete ? data.playingCount : null,
        totalAmountPlayed: metricsComplete ? data.totalCashPlayed : null,
        totalAmountWon: metricsComplete ? data.totalWinAmount : null,
        totalAmountLost: metricsComplete ? data.totalLossAmount : null,
        averageAmountPlayed: metricsComplete ? data.averageSpending : null,
        maxAmountPlayed: metricsComplete ? data.maxSpending : null,
        metricsComplete,
        sourceGap: anchor < 0 && this.checkpoint !== null && batch.length === 0,
      };
      batch.push(roundData);
    }

    if (!this.capture) throw new CaptureFailure("Durable collection handler is not configured");
    const checkpoint = this.generateBustID(data.busts, 0);
    try { await this.capture(batch, checkpoint); }
    catch (error) { throw new CaptureFailure(error instanceof Error ? error.message : String(error)); }
    this.checkpoint = checkpoint;
    this.lastRoundAt = this.now();
    this.restartCount = 0;
    this.outageSince = null;
    this.failureKind = null;
    this.captureError = null;
  }

  private generateBustID(busts: number[], index: number): string {
    return busts.slice(index, index + 10).join("-");
  }
}

export const gameScraper = new GameScraper();
