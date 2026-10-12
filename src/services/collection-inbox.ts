import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RoundData } from "./scraper.js";

export type CapturedRound = RoundData & { ingestionId: string; capturedAt: string };
type State = { checkpoint: string | null; pending: CapturedRound[] };

/** Single collector durable inbox. Capture commits before the source cursor advances. */
export class CollectionInbox {
  private state: State = { checkpoint: null, pending: [] };
  private writes = Promise.resolve();
  private worker: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastSavedAt: number | null = null;
  private failures = 0;
  constructor(private path: string, private consume: (round: CapturedRound) => Promise<void>) {}

  async initialize(databaseCheckpoint: string | null) {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as State;
      if (!Array.isArray(state.pending) || !(state.checkpoint === null || typeof state.checkpoint === "string") ||
          state.pending.some(r => !r.ingestionId || !Number.isFinite(r.bust) || !r.bustId || !Number.isFinite(Date.parse(r.capturedAt)))) {
        throw new Error("Invalid collection inbox; preserve the file and recover it before starting");
      }
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state.checkpoint = databaseCheckpoint;
    }
    this.kick();
    return this.state.checkpoint;
  }

  getStatus() {
    return { pending: this.state.pending.length, saveFailures: this.failures,
      lastSavedAt: this.lastSavedAt === null ? null : new Date(this.lastSavedAt).toISOString() };
  }

  private async persist(state: State) {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(`${this.path}.tmp`, "w", 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(`${this.path}.tmp`, this.path);
    // Directory fsync is supported on Linux, where production runs.
    if (process.platform !== "win32") {
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }

  private change(update: (state: State) => State) {
    const task = this.writes.then(async () => {
      const next = update(this.state);
      await this.persist(next);
      this.state = next;
    });
    this.writes = task.catch(() => undefined);
    return task;
  }

  async capture(batch: RoundData[], checkpoint: string) {
    if (this.stopped) throw new Error("Collection is stopping");
    await this.change(state => {
      if (state.pending.length + batch.length > 10_000) throw new Error("Collection inbox full; refusing to discard rounds");
      const start = Date.now() - batch.length;
      return { checkpoint, pending: [...state.pending, ...batch.map((r, i) => ({
        ...r, ingestionId: randomUUID(), capturedAt: new Date(start + i).toISOString(),
      }))] };
    });
    this.kick();
  }

  private kick() {
    if (this.worker || this.timer || this.stopped || !this.state.pending.length) return;
    this.worker = this.process().catch(error => {
      this.failures++;
      console.error("Collection save failed; durable round retained for retry:", error);
    }).finally(() => {
      this.worker = null;
      if (!this.stopped && this.state.pending.length) {
        this.timer = setTimeout(() => { this.timer = null; this.kick(); }, Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5)));
      }
    });
  }

  private async process() {
    while (this.state.pending.length) {
      const round = this.state.pending[0]!;
      await this.consume(round);
      await this.change(state => ({ ...state, pending: state.pending.filter(r => r.ingestionId !== round.ingestionId) }));
      this.lastSavedAt = Date.now();
      this.failures = 0;
    }
  }

  async drain() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.worker;
    await this.writes;
    // Unconsumed records remain on disk, including when the database is unavailable.
  }
}
