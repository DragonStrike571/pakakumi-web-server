import { chromium, Browser } from "playwright";
import { BotSession } from "./session.js";
import { StrategyConfig } from "../../utils/strategies/core.js";
import { db } from "../../db/index.js";
import { botSessions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { trycatch } from "../../utils/try-catch.js";
import { config } from "dotenv";

config();

export class BotManager {
  private browser: Browser | null = null;
  private sessions: Map<string, BotSession> = new Map();
  private isInitialized = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {}

  async initialize() {
    if (this.isInitialized) return;

    console.log("Initializing Bot Manager (Launching Browser)...");

    // Mark any orphaned "active" sessions from previous crashes as "failed"
    const { error: cleanupError } = await trycatch(async () => {
      await db
        .update(botSessions)
        .set({ status: "failed", endedAt: new Date() })
        .where(eq(botSessions.status, "active"));
    });
    if (cleanupError) {
      console.warn("⚠️ Could not clean up orphaned sessions:", cleanupError);
    } else {
      console.log("✅ Orphaned bot sessions cleaned up.");
    }

    const { data: browser, error } = await trycatch(async () => {
      return await chromium.launch({
        headless: process.env.HEADLESS !== "false",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    });

    if (error || !browser) {
      console.error("Failed to launch browser:", error);
      throw error || new Error("Failed to launch browser");
    }

    this.browser = browser;
    this.isInitialized = true;

    // Periodic health check: detect sessions with dead pages
    this.healthCheckInterval = setInterval(() => this.healthCheck(), 30000);
  }

  async startSession(
    userId: string,
    strategyId: string,
    strategyConfig: StrategyConfig,
    initialCapital: number,
    auth: { phone: string; pass: string },
  ) {
    if (!this.browser) await this.initialize();
    if (!this.browser) throw new Error("Browser failed to initialize");

    // 1. Create DB entry
    const { data: sessionData, error } = await trycatch(async () => {
      return await db
        .insert(botSessions)
        .values({
          userId,
          strategyId,
          status: "active",
          initialCapital: initialCapital,
          currentCapital: initialCapital,
          totalProfit: 0,
          currentStep: 0,
          logs: [],
        })
        .returning();
    });

    if (error || !sessionData) {
      throw error || new Error("Failed to create session record");
    }

    const [sessionRecord] = sessionData;

    const sessionId = sessionRecord.id;

    // 2. Create Session Object
    const session = new BotSession(
      this.browser,
      {
        sessionId,
        userId,
        strategyId,
        strategyConfig,
        initialCapital,
        auth,
      },
      { currentStep: 0, currentCapital: initialCapital },
    );

    this.sessions.set(sessionId, session);

    // 3. Start Session
    // Do not await this, let it run in background
    session.start(this.browser).catch((err) => {
      console.error(`Session ${sessionId} crashed on start:`, err);
    });

    // 4. Hook up listeners (logs, etc)
    session.on("stopped", () => {
      this.sessions.delete(sessionId);
    });

    return sessionId;
  }

  async stopSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const { error } = await trycatch(
        async () => await session.stop("stopped"),
      );
      this.sessions.delete(sessionId);
      if (error) {
        console.error(`Error stopping session ${sessionId}:`, error);
      }
      return true;
    }
    return false;
  }

  /**
   * Gracefully stop all active sessions and close the browser.
   */
  async shutdownAll() {
    console.log(`🛑 Shutting down ${this.sessions.size} bot session(s)...`);

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    const stopPromises = Array.from(this.sessions.keys()).map((id) =>
      this.stopSession(id),
    );
    await Promise.allSettled(stopPromises);

    if (this.browser) {
      await trycatch(async () => {
        await this.browser!.close();
      });
      this.browser = null;
    }

    this.isInitialized = false;
    console.log("✅ Bot Manager shut down.");
  }

  /**
   * Periodic health check: if a session's browser context is dead, stop it.
   */
  private async healthCheck() {
    for (const [sessionId, session] of this.sessions) {
      try {
        // A quick check — if the session's page is closed, the session is dead
        const isAlive =
          (session as any).page && !(session as any).page.isClosed();
        if (!isAlive) {
          console.warn(`⚠️ Session ${sessionId} page is dead. Cleaning up.`);
          await this.stopSession(sessionId);
        }
      } catch {
        // If we can't check, assume dead
        console.warn(
          `⚠️ Session ${sessionId} health check failed. Cleaning up.`,
        );
        await this.stopSession(sessionId);
      }
    }
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  getActiveSessionsForUser(userId: string) {
    const userSessions: BotSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        userSessions.push(session);
      }
    }
    return userSessions;
  }
}

export const botManager = new BotManager();
