import { hasActiveAccess } from "../config/access.js";

export class SocketAccessGuard {
  private queue = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private getSession: () => Promise<{ user?: { role?: string; accessStatus?: string } | null;
    session?: { expiresAt: Date | string } } | null>, private terminate: () => void) {}

  send(send: () => void) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const session = await Promise.race([this.getSession(), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("WebSocket authorization timed out")), 5000);
        })]);
        const expires = new Date(session?.session?.expiresAt || 0).getTime();
        if (this.closed) return;
        if (!hasActiveAccess(session?.user) || expires <= Date.now() || !Number.isFinite(expires)) return this.revoke();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.revoke(), Math.min(expires - Date.now(), 2_147_483_647));
        send();
      } catch { this.revoke(); }
      finally { clearTimeout(timeout); }
    });
    return this.queue;
  }

  private revoke() { this.dispose(); this.terminate(); }
  dispose() { this.closed = true; clearTimeout(this.timer); }
}
