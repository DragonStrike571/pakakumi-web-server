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

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

// CORS origins from env (comma-separated) or defaults
const CORS_ORIGINS = [
  "https://pakakumi-web-client.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiter for Auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    xForwardedForHeader: false,
  },
});

// Better Auth Handler
app.use("/api/auth", authLimiter, toNodeHandler(auth));

// Use JSON middleware
app.use(express.json());

// Root route
app.get("/", (req: Request, res: Response) => {
  res.send("Pakakumi Web Server is running!");
});

// Health check route
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
  }
});

// Start the scraper
gameScraper
  .start()
  .catch((err) => console.error("❌ Failed to start scraper:", err));

// Initialize Services
Promise.all([roundService.initialize(), botManager.initialize()])
  .then(() => console.log("✅ Services initialized"))
  .catch((err) => console.error("❌ Failed to initialize services:", err));

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

  // Stop accepting new connections
  server.close(() => {
    console.log("✅ HTTP server closed");
  });

  // Stop scraper browser
  await trycatch(async () => {
    await gameScraper.stop();
    console.log("✅ Scraper stopped");
  });

  // Stop all bot sessions and close bot browser
  await trycatch(async () => {
    await botManager.shutdownAll();
    console.log("✅ Bot manager shut down");
  });

  // Drain DB pool
  await trycatch(async () => {
    await pool.end();
    console.log("✅ Database pool drained");
  });

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
