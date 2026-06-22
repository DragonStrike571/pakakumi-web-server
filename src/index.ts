import express, { Request, Response } from "express";
import http from "http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { trycatch } from "./utils/try-catch.js";
import roundsRouter from "./routes/rounds.js";
import { attachWebSocketServer } from "./ws/server.js";
import { gameScraper } from "./services/scraper.js";
import { roundService } from "./services/round.js";
import strategiesRouter from "./routes/strategies.js";
import botRouter from "./routes/bot.js";
import accountRouter from "./routes/account.js";
import { botManager } from "./services/bot/manager.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import cors from "cors";
import { pool } from "./db/index.js";
import paystackRouter from "./routes/paystack.js";

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
  "PAYSTACK_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
import { CORS_ORIGINS } from "./config/cors.js";

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

// Security middleware
app.use(
  helmet({
    crossOriginOpenerPolicy: { policy: "unsafe-none" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiter for Auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

app.use("/api/auth", authLimiter, toNodeHandler(auth));
app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.send("Pakakumi Web Server is running!");
});

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    scraperState: roundService.getState(),
  });
});

app.use("/rounds", roundsRouter);
app.use("/strategies", strategiesRouter);
app.use("/bot", botRouter);
app.use("/account", accountRouter);
app.use("/paystack", paystackRouter);

// WEBHOOK REMOVED: Telegram now operates entirely via background polling

const { broadcastRoundUpdate } = attachWebSocketServer(server);
app.locals.broadcastRoundUpdate = broadcastRoundUpdate;

// Initialize Scraper
gameScraper.on("roundEnded", async (data) => {
  const { data: savedRound, error } = await trycatch(async () => {
    return await roundService.processRound(data);
  });

  if (error) {
    console.error("❌ Error processing round:", error);
    return;
  }

  if (savedRound) {
    broadcastRoundUpdate({
      ...savedRound,
      bust: Number(savedRound.bust),
      totalAmountPlayed: Number(savedRound.totalAmountPlayed),
      totalAmountWon: Number(savedRound.totalAmountWon),
      totalAmountLost: Number(savedRound.totalAmountLost),
      averageAmountPlayed: Number(savedRound.averageAmountPlayed),
      maxAmountPlayed: Number(savedRound.maxAmountPlayed),
      totalReserveFunds: Number(savedRound.totalReserveFunds),
    });

    runAnalysis({
      bust: Number(savedRound.bust),
      createdAt: savedRound.createdAt,
    }).catch((err) => console.error("❌ Analyzer error:", err));
  }
});

gameScraper
  .start()
  .catch((err) => console.error("❌ Failed to start scraper:", err));

// Initialize Services & Background Daemons
Promise.all([roundService.initialize(), botManager.initialize()])
  .then(() => {
    console.log("✅ Core services initialized");

    // Start Background Pollers
    startPaystackPolling();
    console.log("✅ Paystack verification polling started");

    startExpiryKicker();
    console.log("✅ Expiry kicker daemon started");

    // Start Telegram Long-Polling
    if (bot) {
      bot
        .start({ drop_pending_updates: true })
        .catch((err) => console.error("❌ Failed to start bot polling:", err));
      console.log("✅ Telegram Daemon active (Long-Polling)");
    }
  })
  .catch((err) => console.error("❌ Failed to initialize services:", err));

// Catch unhandled promises that bypass the Express/Grammy error handlers
process.on("unhandledRejection", (reason, promise) => {
  console.error("🚨 Unhandled Rejection at:", promise, "reason:", reason);
  // Do not exit the process here; log it and let it recover
});

process.on("uncaughtException", (error) => {
  console.error("🚨 Uncaught Exception thrown:", error);
  // If it's a critical core crash, log and allow PM2/Docker to restart it safely
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const baseUrl =
    HOST === "0.0.0.0" ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server is running on ${baseUrl}`);
  console.log(
    `WebSocket server is running on ${baseUrl.replace("http", "ws")}/ws`,
  );
});

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);

  server.close(() => console.log("✅ HTTP server closed"));

  await trycatch(async () => {
    await gameScraper.stop();
    console.log("✅ Scraper stopped");
  });

  await trycatch(async () => {
    await botManager.shutdownAll();
    console.log("✅ Bot manager shut down");
  });

  // Safely terminate Telegram polling connections
  if (bot) {
    await trycatch(async () => {
      await bot!.stop();
      console.log("✅ Telegram polling stopped");
    });
  }

  await trycatch(async () => {
    await pool.end();
    console.log("✅ Database pool drained");
  });

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
