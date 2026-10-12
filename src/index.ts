import express, { type NextFunction, Request, Response } from "express";
import http from "http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { trycatch } from "./utils/try-catch.js";
import { CollectionInbox, type CapturedRound } from "./services/collection-inbox.js";
import { resolve } from "node:path";
import { drainAnalysis } from "./services/analysis/engine.js";
import { balancePool } from "./services/balance-pool.js";
import { backtestRunner } from "./services/backtest/runner.js";
import { shutdownWithDeadline } from "./utils/shutdown.js";
import { startDeliveryWorker } from "./services/telegram/outbox.js";
import roundsRouter from "./routes/rounds.js";
import { attachWebSocketServer } from "./ws/server.js";
import { gameScraper } from "./services/scraper.js";
import { roundService } from "./services/round.js";
import strategiesRouter from "./routes/strategies.js";
import botRouter from "./routes/bot.js";
import accountRouter from "./routes/account.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import cors from "cors";
import { pool } from "./db/index.js";
import paystackRouter from "./routes/paystack.js";
import analysisRouter from "./routes/analysis.js";
import backtestsRouter from "./routes/backtests.js";

// Core Daemons
import { bot } from "./services/telegram/bot.js";
import { runAnalysis } from "./services/telegram/analyzer.js";
import { startPaystackPolling } from "./services/paystack/paystack.js";
import { startExpiryKicker } from "./services/telegram/expiry.js";

// Environment variable validation
const requiredEnvVars = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY!)) {
  throw new Error("ENCRYPTION_KEY must be exactly 64 hexadecimal characters");
}
if (process.env.BETTER_AUTH_SECRET!.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
}

const PORT = Number(process.env.PORT || 8000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const HOST = process.env.HOST || "0.0.0.0";
const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS
  ? Number(process.env.TRUST_PROXY_HOPS)
  : 0;
if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0 || TRUST_PROXY_HOPS > 5) {
  throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");
}
import { CORS_ORIGINS } from "./config/cors.js";

const app = express();
const server = http.createServer(app);
const toNullableNumber = (value: number | string | null) =>
  value === null ? null : Number(value);

app.set("trust proxy", TRUST_PROXY_HOPS || false);

// Security middleware
app.use(helmet());

// Configure CORS
app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  }),
);

app.use((req, res, next) => {
  // Filter noisy health check and WebSocket upgrade logs
  if (req.url !== "/health" && req.url !== "/ws") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
}));

// Rate limiter for Auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/auth", authLimiter, toNodeHandler(auth));
app.use(express.json({ limit: "100kb" }));

app.get("/", (req: Request, res: Response) => {
  res.send("Pakakumi Web Server is running!");
});

app.get("/health", (req: Request, res: Response) => {
  const scraper = gameScraper.getStatus();
  const healthy = scraper.running && scraper.captureError === null && collectionInbox.getStatus().saveFailures === 0;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    collection: collectionInbox.getStatus(),
    uptime: process.uptime(),
    scraper: gameScraper.getStatus(),
    scraperState: roundService.getState(),
  });
});

app.use("/rounds", roundsRouter);
app.use("/strategies", strategiesRouter);
app.use("/bot", botRouter);
app.use("/account", accountRouter);
app.use("/paystack", paystackRouter);
app.use("/analysis", analysisRouter);
app.use("/backtests", backtestsRouter);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Endpoint not found" });
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(`Unhandled request error for ${req.method} ${req.path}:`, error);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

// WEBHOOK REMOVED: Telegram now operates entirely via background polling

const {
  broadcastRoundUpdate,
  broadcastAnalysisUpdate,
  closeWebSocketServer,
} = attachWebSocketServer(server);
app.locals.broadcastRoundUpdate = broadcastRoundUpdate;

// Initialize Scraper
async function handleRoundEnded(data: CapturedRound) {
  const savedRound = await roundService.processRound(data);

  if (savedRound) {
    broadcastRoundUpdate({
      ...savedRound,
      bust: Number(savedRound.bust),
      totalAmountPlayed: toNullableNumber(savedRound.totalAmountPlayed),
      totalAmountWon: toNullableNumber(savedRound.totalAmountWon),
      totalAmountLost: toNullableNumber(savedRound.totalAmountLost),
      averageAmountPlayed: toNullableNumber(savedRound.averageAmountPlayed),
      maxAmountPlayed: toNullableNumber(savedRound.maxAmountPlayed),
      totalReserveFunds: toNullableNumber(savedRound.totalReserveFunds),
    });

    await runAnalysis({
      id: savedRound.id,
      bust: Number(savedRound.bust),
      createdAt: savedRound.createdAt,
    })
      .then((analysisResult) => {
        if (analysisResult) {
          broadcastAnalysisUpdate({
            activeSignals: analysisResult.activeSignals.map((a) => ({
              target: a.target,
              confidence: a.confidence,
              expectedRoundsRemaining: a.expectedRoundsRemaining,
              status: a.status,
              reason: a.reason,
              roundsElapsed: a.roundsElapsed,
            })),
            correlationStreaks: analysisResult.correlationStreaks,
            upcomingOpportunities: analysisResult.upcomingOpportunities.map(
              (o) => ({
                target: o.target,
                confidence: o.confidence,
                expectedGap: o.expectedGap,
                expectedRoundsRemaining: o.expectedRoundsRemaining,
                pureOverdueRatio: o.pureOverdueRatio,
                reason: o.reason,
                idealPlanRounds: o.idealPlanRounds,
                isLate: o.isLate,
              }),
            ),
            stats: analysisResult.stats,
            hitTargets: analysisResult.hitTargets,
          });
        }
      })
      .catch((err) => { console.error("❌ Analyzer error; durable observation will retry:", err); throw err; });
  }
}

const collectionInbox = new CollectionInbox(resolve(process.env.COLLECTION_DATA_DIR || "data", "round-inbox.json"), handleRoundEnded);

let stopPaystackPolling: () => Promise<void> = async () => undefined;
let stopExpiryKicker: () => Promise<void> = async () => undefined;
let stopDeliveryWorker: () => Promise<void> = async () => undefined;

async function initializeServices() {
  await roundService.initialize();
  const checkpoint = await collectionInbox.initialize(roundService.getState().lastBustId);
  gameScraper.setCaptureHandler(checkpoint, (batch, checkpoint) => collectionInbox.capture(batch, checkpoint));
  await gameScraper.start();

  if (process.env.PAYSTACK_SECRET_KEY) {
    stopPaystackPolling = startPaystackPolling();
  } else {
    console.warn("Paystack polling disabled: PAYSTACK_SECRET_KEY is not configured");
  }

  if (bot) {
    stopDeliveryWorker = startDeliveryWorker();
    stopExpiryKicker = startExpiryKicker();
    void bot.start({ drop_pending_updates: true }).catch((error) => {
      console.error("Telegram polling stopped unexpectedly:", error);
    });
  } else {
    console.warn("Telegram services disabled: TELEGRAM_BOT_TOKEN is not configured");
  }
}

// Last-resort restart for failures that escaped their task-specific handlers.
// Recoverable client and background task errors must be handled at their source.
let shuttingDown = false;
process.on("unhandledRejection", (reason) => {
  console.error("🚨 Unhandled promise rejection; restarting server:", reason);
  void shutdown("unhandled rejection", 1);
});

process.on("uncaughtException", (error) => {
  console.error("🚨 Uncaught Exception thrown:", error);
  void shutdown("uncaught exception", 1);
});

try {
  await initializeServices();
} catch (error) {
  console.error("Core service initialization failed:", error);
  await shutdown("initialization failure", 1);
}

server.listen(PORT, HOST, () => {
  const baseUrl =
    HOST === "0.0.0.0" ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server is running on ${baseUrl}`);
  console.log(
    `WebSocket server is running on ${baseUrl.replace("http", "ws")}/ws`,
  );
});

// Graceful shutdown
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);

  await shutdownWithDeadline(async () => {
    const clean = async (name: string, task: () => Promise<unknown>) => {
      try { await task(); }
      catch (error) { exitCode = 1; console.error(`Shutdown of ${name} failed:`, error); }
    };
    const daemonsStopped = Promise.all([
      clean("Paystack", stopPaystackPolling), clean("expiry", stopExpiryKicker), clean("outbox", stopDeliveryWorker),
    ]);
    const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeIdleConnections();
    await Promise.all([
      clean("WebSocket", closeWebSocketServer), clean("scraper", () => gameScraper.stop()),
      clean("balance pool", () => balancePool.shutdown()), clean("backtests", () => backtestRunner.shutdown()),
      clean("Telegram polling", async () => { if (bot?.isRunning()) await bot.stop(); }),
    ]);
    await clean("collection inbox", () => collectionInbox.drain());
    await clean("analysis", drainAnalysis);
    await daemonsStopped;
    await httpClosed;
    await clean("database", () => pool.end());
  }, code => process.exit(Math.max(code, exitCode)), exitCode);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
