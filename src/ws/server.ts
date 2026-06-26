import { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { Round } from "../validation/rounds.js";
import { CORS_ORIGINS } from "../config/cors.js";

type WsPayload =
  | { type: "welcome"; message: string }
  | { type: "roundUpdate"; data: Round }
  | {
      type: "analysisUpdate";
      data: {
        activeSignals: any[];
        upcomingOpportunities: any[];
        stats: any;
        hitTargets: number[];
      };
    };

function sendJson(socket: WebSocket, payload: WsPayload) {
  if (socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function broadcastJson(wss: WebSocketServer, payload: WsPayload) {
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) {
      continue;
    }

    client.send(JSON.stringify(payload));
  }
}

export function attachWebSocketServer(httpServer: Server) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 1024 * 1024,
    verifyClient: (info, cb) => {
      const origin = info.origin;
      // Remove trailing slash from origin if present
      const cleanOrigin = origin.endsWith("/") ? origin.slice(0, -1) : origin;

      if (!cleanOrigin) {
        // Require origin header
        cb(false, 401, "Unauthorized");
        return;
      }
      if (CORS_ORIGINS.includes(cleanOrigin)) {
        cb(true);
      } else {
        cb(false, 403, `Forbidden: ${cleanOrigin}`);
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
    broadcastJson(wss, {
      type: "roundUpdate",
      data: round,
    });
  }

  function broadcastAnalysisUpdate(data: {
    activeSignals: any[];
    upcomingOpportunities: any[];
    stats: any;
    hitTargets: number[];
  }) {
    broadcastJson(wss, {
      type: "analysisUpdate",
      data,
    });
  }

  return { broadcastRoundUpdate, broadcastAnalysisUpdate };
}
