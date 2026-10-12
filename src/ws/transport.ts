import { WebSocket } from "ws";

function closeFailedClient(socket: WebSocket, error: unknown) {
  console.error("WebSocket client write failed:", error);
  socket.terminate();
}

export function sendText(socket: WebSocket, serialized: string) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(serialized, (error) => {
      if (error) closeFailedClient(socket, error);
    });
  } catch (error) {
    closeFailedClient(socket, error);
  }
}

/** Keep one failed client from interrupting delivery to the remaining clients. */
export function broadcastText(clients: Iterable<WebSocket>, serialized: string) {
  for (const client of clients) sendText(client, serialized);
}

export function pingClient(socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.ping(undefined, undefined, (error: Error | undefined) => {
      if (error) closeFailedClient(socket, error);
    });
  } catch (error) {
    closeFailedClient(socket, error);
  }
}
