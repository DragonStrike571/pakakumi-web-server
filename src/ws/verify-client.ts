import type { IncomingHttpHeaders } from "node:http";
import type { VerifyClientCallbackAsync } from "ws";

interface Session {
  user?: { role?: string; accessStatus?: string } | null;
}

export function createClientVerifier(
  allowedOrigins: readonly string[],
  getSession: (headers: IncomingHttpHeaders) => Promise<Session | null | undefined>,
): VerifyClientCallbackAsync {
  // ws uses the callback and ignores returned promises. Keep this function sync.
  return (info, cb) => {
    const origin = info.origin;
    // The Origin header can be absent at runtime despite the ws type definition.
    if (typeof origin !== "string" || !origin) {
      cb(false, 401, "Unauthorized");
      return;
    }
    const cleanOrigin = origin.endsWith("/") ? origin.slice(0, -1) : origin;
    if (!cleanOrigin) {
      cb(false, 401, "Unauthorized");
      return;
    }
    if (!allowedOrigins.includes(cleanOrigin)) {
      cb(false, 403, "Forbidden");
      return;
    }

    async function checkAccess() {
      const session = await getSession(info.req.headers);
      const user = session?.user;
      return Boolean(
        user &&
          (user.role === "admin" ||
            user.accessStatus === "active" ||
            user.accessStatus === "telegram_premium"),
      );
    }

    void checkAccess().then(
      (allowed) => cb(allowed, allowed ? undefined : 401, allowed ? undefined : "Unauthorized"),
      () => cb(false, 503, "Authentication unavailable"),
    ).catch((error: unknown) => {
      // Also contain failures thrown while ws completes or rejects the upgrade.
      console.error("WebSocket verification callback failed:", error);
      info.req.socket.destroy();
    });
  };
}
