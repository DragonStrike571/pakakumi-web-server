import { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { Round } from "../validation/rounds.js";

type WsPayload =
  | { type: "welcome"; message: string }
  | { type: "roundUpdate"; data: Round };

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

const CORS_ORIGINS = [
  "https://pakakumi-web-client.vercel.app",
  "https://pakakumi.softdocs.org",
  "http://localhost:3000",
  "http://localhost:5173",
];

export function attachWebSocketServer(httpServer: Server) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 1024 * 1024,
    verifyClient: (info, cb) => {
      const origin = info.origin;
      if (!origin) {
        // Require origin header
        cb(false, 401, "Unauthorized");
        return;
      }
      if (CORS_ORIGINS.includes(origin)) {
        cb(true);
      } else {
        cb(false, 403, "Forbidden");
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

  return { broadcastRoundUpdate };
}
