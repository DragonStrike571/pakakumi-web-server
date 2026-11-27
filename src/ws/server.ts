import { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { Round } from "../validation/rounds.js";
import { CORS_ORIGINS } from "../config/cors.js";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";
import { createClientVerifier } from "./verify-client.js";
import { pingClient, sendText } from "./transport.js";
import { SocketAccessGuard } from "./access-guard.js";
import { createSocketSessionLookup } from "./session-lookup.js";

// ─── Typed WS Payload Interfaces ────────────────────────────────────────────

interface WsActiveSignal {
  openedAt: string;
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
  totalResolved: number;
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
        sourceBustId: string;
        capturedAt: string;
        updatedAt: string;
        deadTargets: number[];
        activeSignals: WsActiveSignal[];
        upcomingOpportunities: WsUpcomingOpportunity[];
        stats: WsAnalysisStats;
        hitTargets: number[];
        correlationStreaks: number[][];
      };
    };

function sendJson(socket: WebSocket, payload: WsPayload) {
  sendText(socket, JSON.stringify(payload));
}

export function attachWebSocketServer(httpServer: Server) {
  const opportunityClients = new Set<WebSocket>();
  const guards = new Map<WebSocket, SocketAccessGuard>();
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 1024 * 1024,
    verifyClient: createClientVerifier(CORS_ORIGINS, (headers) =>
      auth.api.getSession({ headers: fromNodeHeaders(headers) }),
    ),
  });

  wss.on("connection", function (ws: WebSocket & { isAlive?: boolean }, req) {
    if (new URL(req.url ?? "/ws","http://localhost").searchParams.get("stream") === "opportunities") opportunityClients.add(ws);
    ws.on("error", console.error);
    ws.isAlive = true;
    ws.on("pong", function () {
      ws.isAlive = true;
    });

    const guard = new SocketAccessGuard(createSocketSessionLookup(() => auth.api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableCookieCache: true } })), () => ws.terminate());
    guards.set(ws, guard);
    ws.once("close", () => { guard.dispose(); guards.delete(ws); opportunityClients.delete(ws); });
    void guard.send(() => sendJson(ws, {
      type: "welcome",
      message: "Welcome to the Pakakumi Round Analyzer!",
    }));
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket & { isAlive?: boolean }) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }

      ws.isAlive = false;
      void guards.get(ws)?.send(() => pingClient(ws));
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(interval);
  });

  function broadcastRoundUpdate(round: Round) {
    const payload: WsPayload = { type: "roundUpdate", data: round };
    if (guards.size > opportunityClients.size) broadcastAuthorized(JSON.stringify(payload));
  }

  function broadcastAnalysisUpdate(data: {
    sourceBustId: string;
    capturedAt: string;
    updatedAt: string;
    deadTargets: number[];
    activeSignals: WsActiveSignal[];
    upcomingOpportunities: WsUpcomingOpportunity[];
    stats: WsAnalysisStats;
    hitTargets: number[];
    correlationStreaks: number[][];
  }, currentObservation: boolean) {
    if (currentObservation && opportunityClients.size && Date.now() - Date.parse(data.capturedAt) < 5000) {
      const activeSignals = data.activeSignals.map(({openedAt,target,confidence,expectedRoundsRemaining}) =>
        ({openedAt,target,confidence,expectedRoundsRemaining}));
      const message = JSON.stringify({type:"analysisUpdate",data:{sourceBustId:data.sourceBustId,capturedAt:data.capturedAt,activeSignals}});
      for (const socket of opportunityClients) void guards.get(socket)?.send(()=>sendText(socket,message));
    }
    const payload: WsPayload = { type: "analysisUpdate", data };
    if (guards.size > opportunityClients.size) broadcastAuthorized(JSON.stringify(payload));
  }

  function broadcastAuthorized(serialized: string) {
    for (const [ws, guard] of guards) if (!opportunityClients.has(ws)) void guard.send(() => sendText(ws, serialized));
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
