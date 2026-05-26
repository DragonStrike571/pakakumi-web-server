import { Browser, BrowserContext, Page } from "playwright";
import { EventEmitter } from "events";
import { db } from "../../db/index.js";
import { botSessions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  executeStrategy,
  StrategyConfig,
} from "../../utils/strategies/core.js";
import { trycatch } from "../../utils/try-catch.js";
import { GAME_SELECTORS } from "../../utils/selectors.js";

interface SessionConfig {
  sessionId: string;
  userId: string;
  strategyId: string;
  strategyConfig: StrategyConfig;
  initialCapital: number;
  auth: { phone: string; pass: string };
}

const MAX_CONSECUTIVE_ERRORS = 10;

export class BotSession extends EventEmitter {
  public sessionId: string;
  public userId: string;
  private browserContext: BrowserContext | null = null;
  private page: Page | null = null;
  private config: SessionConfig;
  private isRunning = false;
  private currentStep = 0;
  private currentCapital = 0;
  private profit = 0;
  private logs: string[] = [];

  constructor(
    private browser: Browser,
    config: SessionConfig,
    savedState?: { currentStep: number; currentCapital: number },
  ) {
    super();
    this.config = config;
    this.sessionId = config.sessionId;
    this.userId = config.userId;
    this.currentCapital = savedState?.currentCapital || config.initialCapital;
    this.currentStep = savedState?.currentStep || 0;
  }

  async start(browser: Browser) {
    if (this.isRunning) return;

    try {
      this.log("🚀 Starting session...");
      this.browserContext = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        isMobile: false,
        hasTouch: false,
      });
      this.page = await this.browserContext.newPage();

      this.isRunning = true;
      await this.updateStatus("active");

      await this.page.exposeFunction("onBotRoundEnd", (bustInfo: string) => {
        if (!this.isRunning) return;
        this.processRoundEnd(bustInfo).catch((err) => {
          this.log(`⚠️ Error processing round end: ${err.message}`);
        });
      });

      await this.login();

      // ---> ADD THIS LINE: Wait for the table to exist before observing it
      await this.page.waitForSelector(GAME_SELECTORS.GAME.TABLE_BODY, {
        timeout: 15000,
      });

      // Inject MutationObserver to replace polling
      await this.page.evaluate((selector: string) => {
        const targetNode = document.querySelector(selector);
        if (!targetNode) return;

        let previousBust: string | null = null;

        new MutationObserver(() => {
          const el = document.querySelector(
            "table.css-1a87jyo tbody tr.css-15iar3s td span.css-hwpcld",
          );
          if (el && el.textContent) {
            const latestBustInfo = el.textContent;
            if (latestBustInfo !== previousBust) {
              previousBust = latestBustInfo;
              (window as any).onBotRoundEnd(latestBustInfo);
            }
          }
        }).observe(targetNode, { childList: true, subtree: true });

        // Run once immediately
        const el = document.querySelector(
          "table.css-1a87jyo tbody tr.css-15iar3s td span.css-hwpcld",
        );
        if (el && el.textContent) {
          const latestBustInfo = el.textContent;
          if (latestBustInfo !== previousBust) {
            previousBust = latestBustInfo;
            (window as any).onBotRoundEnd(latestBustInfo);
          }
        }
      }, GAME_SELECTORS.GAME.TABLE_BODY);
    } catch (error: any) {
      this.log(`❌ Error starting session: ${error.message}`);
      await this.stop("failed");
    }
  }

  async stop(status: "stopped" | "completed" | "failed" = "stopped") {
    this.isRunning = false;
    if (this.browserContext) {
      await this.browserContext.close();
      this.browserContext = null;
    }
    await this.updateStatus(status);
    this.log(`🛑 Session stopped (${status}).`);
    this.emit("stopped", this.sessionId);
  }

  private async login() {
    if (!this.page) return;
    this.log("Logging in...");

    const { error } = await trycatch(
      async () => {
        if (!this.page) throw new Error("Page not initialized");
        await this.page.goto("https://play.pakakumi.com/login");

        // Wait for inputs
        await this.page.waitForSelector(GAME_SELECTORS.LOGIN.PHONE_INPUT, {
          timeout: 10000,
        });

        const phoneInput = await this.page.$(GAME_SELECTORS.LOGIN.PHONE_INPUT);
        const passInput = await this.page.$(GAME_SELECTORS.LOGIN.PASS_INPUT);
        const loginBtn = await this.page.$(GAME_SELECTORS.LOGIN.SUBMIT_BTN);

        if (!phoneInput || !passInput || !loginBtn) {
          throw new Error("Login fields not found on page.");
        }

        // Fill and click
        await phoneInput.fill(this.config.auth.phone, { force: true });
        await passInput.fill(this.config.auth.pass, { force: true });

        // Sometimes frontend frameworks miss rapid headless clicks.
        // Adding a tiny delay before clicking helps.
        await this.page.waitForTimeout(500);
        await loginBtn.click({ force: true });

        // TRUE VERIFICATION: Wait for the guest prompt to disappear
        try {
          await this.page.waitForFunction(
            () => {
              return !document.body.innerText.includes(
                "Login or Register to start playing.",
              );
            },
            { timeout: 10000 },
          );

          this.log("✅ Login Successful (Guest UI removed)");
        } catch (verifyError) {
          // If the text is still there, the login failed. Let's see what the screen says.
          const pageText = await this.page.evaluate(
            () => document.body.innerText,
          );
          this.log(
            `❌ Login rejected. Screen text: \n ${pageText.substring(0, 300)}`,
          );
          throw new Error("Login click did not authenticate the session.");
        }
      },
      { retries: 1, retryDelay: 2000 }, // Reduced retries so it fails faster if stuck
    );

    if (error) {
      throw error;
    }
  }

  /**
   * Read the #tour_multiplier element to determine the current game phase.
   *  - 'playing'  → multiplier is climbing (e.g. "12.76x")
   *  - 'waiting'  → countdown before next round ("Next Round In  5.0")
   *  - 'busted'   → round ended ("Busted @ 2.36x")
   */
  private async getGameState(): Promise<"playing" | "waiting" | "busted"> {
    if (!this.page) return "playing";

    const text = await this.page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      return el?.textContent?.trim() || "";
    }, GAME_SELECTORS.GAME.MULTIPLIER_DISPLAY);

    if (text.includes("Busted") || text.includes("@")) return "busted";
    if (text.includes("Next Round In")) return "waiting";
    return "playing";
  }

  /**
   * Wait until the game enters the "waiting" phase (Next Round In countdown),
   * which is the only safe window to place a bet for the upcoming round.
   */
  private async waitForBettingWindow(timeoutMs = 15000): Promise<boolean> {
    if (!this.page) return false;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.isRunning) return false;
      const state = await this.getGameState();
      if (state === "waiting") return true;
      await this.page.waitForTimeout(150);
    }

    this.log("⚠️ Timed out waiting for betting window.");
    return false;
  }

  // loop() replaced by MutationObserver in start()

  private lastBet: { amount: number; cashout: number } | null = null;

  private async processRoundEnd(bustStr: string) {
    const bustVal = parseFloat(bustStr.replace("x", "").replace(",", ""));

    if (this.lastBet) {
      if (bustVal >= this.lastBet.cashout) {
        const profit =
          this.lastBet.amount * this.lastBet.cashout - this.lastBet.amount;
        this.profit += profit;
        this.currentCapital += profit;
        this.log(`🎉 WON! Bust: ${bustVal}x. Profit: +${profit.toFixed(2)}`);
      } else {
        const loss = this.lastBet.amount;
        this.profit -= loss;
        this.currentCapital -= loss;
        this.log(`📉 LOST. Bust: ${bustVal}x. Loss: -${loss.toFixed(2)}`);
      }

      await this.updateSessionState();
    } else {
      this.log(`Round ended: ${bustVal}x (No bet)`);
    }

    // Calculate NEXT move
    const { action, nextStep } = executeStrategy(
      this.config.strategyConfig,
      this.currentStep,
      this.lastBet
        ? {
            bust: bustVal,
            betPlaced: this.lastBet.amount,
            cashout: this.lastBet.cashout,
          }
        : undefined,
    );

    this.currentStep = nextStep;

    if (action.stop) {
      this.log("Strategy signaled stop.");
      await this.stop("completed");
      return;
    }

    if (action.shouldBet) {
      if (this.currentCapital < action.amount) {
        this.log(
          `⚠️ Insufficient capital (${this.currentCapital}) for bet ${action.amount}. Stopping.`,
        );
        await this.stop("failed");
        return;
      }

      // Wait for the "Next Round In" countdown before placing the bet.
      // This ensures we always bet on the immediately-next round.
      const ready = await this.waitForBettingWindow();
      if (!ready) {
        this.log("⚠️ Could not reach betting window. Skipping this bet.");
        this.lastBet = null;
        return;
      }

      await this.placeBet(action.amount, action.cashout);
    } else {
      this.lastBet = null;
      this.log("Skipping round (Strategy decision).");
    }
  }

  private async placeBet(amount: number, cashout: number) {
    if (!this.page) return;

    try {
      // 1. Force Playwright to wait for the inputs to render on the DOM
      await this.page.waitForSelector(GAME_SELECTORS.GAME.INPUTS, {
        state: "attached",
        timeout: 2500,
      });

      // Now it is safe to grab them
      const inputs = await this.page.$$(GAME_SELECTORS.GAME.INPUTS);
      const betBtn = await this.page.$(GAME_SELECTORS.GAME.BET_BUTTON);

      if (inputs.length < 2 || !betBtn) {
        throw new Error(
          `Found ${inputs.length} inputs. Could not locate both fields or the bet button.`,
        );
      }

      const amountInput = inputs[0];
      const cashoutInput = inputs[1];

      // 2. Click first to ensure UI focus, then fill
      await amountInput.click();
      await amountInput.fill(amount.toString());

      await cashoutInput.click();
      await cashoutInput.fill(cashout.toString());

      await betBtn.click();

      this.lastBet = { amount, cashout };
      this.log(`🎲 Placed Bet: ${amount} @ ${cashout}x`);
    } catch (error: any) {
      this.log(`❌ Error placing bet: ${error.message}`);

      const pageText = await this.page.evaluate(() => document.body.innerText);
      this.log(`🔍 WHAT THE BOT SEES: \n ${pageText.substring(0, 500)}`);

      this.lastBet = null;
    }
  }

  private async updateStatus(status: string) {
    await trycatch(async () => {
      await db
        .update(botSessions)
        .set({
          status,
          currentCapital: this.currentCapital,
          totalProfit: this.profit,
          currentStep: this.currentStep,
          logs: this.logs,
          endedAt: status !== "active" ? new Date() : undefined,
        })
        .where(eq(botSessions.id, this.sessionId));
    });
  }

  private async updateSessionState() {
    await trycatch(async () => {
      await db
        .update(botSessions)
        .set({
          currentCapital: this.currentCapital,
          totalProfit: this.profit,
          currentStep: this.currentStep,
          logs: this.logs,
        })
        .where(eq(botSessions.id, this.sessionId));
    });
  }

  private log(message: string) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(`[Bot ${this.sessionId}] ${message}`);
    this.logs.push(logEntry);

    // Keep max 1000 logs in memory to avoid unbounded growth
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-1000);
    }

    this.emit("log", { sessionId: this.sessionId, message: logEntry });
  }
}
