import { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { Round } from "../validation/rounds.js";
import { CORS_ORIGINS } from "../config/cors.js";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";

// ─── Typed WS Payload Interfaces ────────────────────────────────────────────

interface WsActiveSignal {
  target: number;
  confidence: number;
  expectedRoundsRemaining: number;
  status: string;
  reason: string;
  roundsElapsed: number;
}

interface WsUpcomingOpportunity {
  target: number;
  confidence: number;
  expectedGap: number;
  expectedRoundsRemaining: number;
  pureOverdueRatio: number;
  reason: string;
  idealPlanRounds: number;
  isLate: boolean;
}

interface WsAnalysisStats {
  totalSignals: number;
  totalHits: number;
  accuracy: number;
  roundsAnalyzed: number;
}

type WsPayload =
  | { type: "welcome"; message: string }
  | { type: "roundUpdate"; data: Round }
  | {
      type: "analysisUpdate";
      data: {
        activeSignals: WsActiveSignal[];
        upcomingOpportunities: WsUpcomingOpportunity[];
        stats: WsAnalysisStats;
        hitTargets: number[];
        correlationStreaks: number[][];
      };
    };

function sendJson(socket: WebSocket, payload: WsPayload) {
  if (socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

/**
 * Broadcast a pre-serialized JSON string to all connected clients.
 * Serializes once instead of per-client for better performance at scale.
 */
function broadcastPreSerialized(wss: WebSocketServer, serialized: string) {
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) {
      continue;
    }
    client.send(serialized);
  }
}

export function attachWebSocketServer(httpServer: Server) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 1024 * 1024,
    verifyClient: async (info, cb) => {
      const origin = info.origin;
      // Remove trailing slash from origin if present
      const cleanOrigin = origin.endsWith("/") ? origin.slice(0, -1) : origin;

      if (!cleanOrigin) {
        // Require origin header
        cb(false, 401, "Unauthorized");
        return;
      }
      if (!CORS_ORIGINS.includes(cleanOrigin)) {
        cb(false, 403, `Forbidden: ${cleanOrigin}`);
        return;
      }

      try {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(info.req.headers),
        });
        const user = session?.user as
          | (NonNullable<typeof session>["user"] & {
              role?: string;
              accessStatus?: string;
            })
          | undefined;
        const allowed = Boolean(
          user &&
          (user.role === "admin" ||
            user.accessStatus === "active" ||
            user.accessStatus === "telegram_premium"),
        );
        cb(allowed, allowed ? undefined : 401, allowed ? undefined : "Unauthorized");
      } catch {
        cb(false, 503, "Authentication unavailable");
      }
    },
  });

  wss.on("connection", function (ws: WebSocket & { isAlive?: boolean }) {
    ws.isAlive = true;
    ws.on("pong", function () {
      ws.isAlive = true;
    });

    sendJson(ws, {
      type: "welcome",
      message: "Welcome to the Pakakumi Round Analyzer!",
    });

    ws.on("error", console.error);
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket & { isAlive?: boolean }) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(interval);
  });

  function broadcastRoundUpdate(round: Round) {
    const payload: WsPayload = { type: "roundUpdate", data: round };
    broadcastPreSerialized(wss, JSON.stringify(payload));
  }

  function broadcastAnalysisUpdate(data: {
    activeSignals: WsActiveSignal[];
    upcomingOpportunities: WsUpcomingOpportunity[];
    stats: WsAnalysisStats;
    hitTargets: number[];
    correlationStreaks: number[][];
  }) {
    const payload: WsPayload = { type: "analysisUpdate", data };
    broadcastPreSerialized(wss, JSON.stringify(payload));
  }

  async function closeWebSocketServer() {
    clearInterval(interval);
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  }

  return {
    broadcastRoundUpdate,
    broadcastAnalysisUpdate,
    closeWebSocketServer,
  };
}
