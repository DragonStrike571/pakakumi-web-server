import { createBacktest, type BacktestRound, type BacktestSettings } from "./engine.js";
import { createSavedRun, finishSavedRun, interruptSavedRun, savePracticeRound } from "./history.js";

const day = 24 * 60 * 60 * 1000;
const capacity = 100;
const archiveFailureReason = "Practice stopped before the next result could be saved.";
type PracticeRun = ReturnType<typeof createBacktest>;
type PracticeResult = ReturnType<PracticeRun["result"]> & { dataset: PracticeRun["dataset"] };

interface PracticeSession {
  id: string;
  name: string;
  run: PracticeRun;
  saved: PracticeResult;
  startedAt: number;
  expiresAt: number;
  reason: string | null;
  pending: Promise<void>;
  saving: boolean;
}

export class HostedPractice {
  private readonly sessions = new Map<string, PracticeSession>();
  private readonly starting = new Set<string>();
  private lastRoundAt = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  private expire() {
    const now = this.clock();
    for (const [user, session] of this.sessions) {
      if (now < session.expiresAt) continue;
      if (session.reason && !session.saving) this.sessions.delete(user);
      else if (session.reason) continue;
      else this.finish(session, "The 24-hour practice limit was reached.");
    }
  }

  private finish(session: PracticeSession, reason: string) {
    session.reason = reason;
    session.expiresAt = this.clock() + day;
    session.saving = true;
    const result = this.savedResult(session);
    session.pending = session.pending.then(async () => {
      if (session.reason === reason) await finishSavedRun(session.id, result, reason);
    }).catch(error => this.archiveFailure(session, error)).finally(() => { session.saving = false; });
  }

  async start(user: string, name: string, settings: BacktestSettings) {
    this.expire();
    if (this.starting.has(user) || this.sessions.get(user)?.reason === null || this.sessions.get(user)?.saving) throw new Error("A practice session is already running or saving.");
    if (!this.sessions.has(user) && this.sessions.size + this.starting.size >= capacity) {
      const completed = [...this.sessions].find(([, session]) => session.reason !== null && !session.saving);
      if (!completed) throw new Error("The practice server is busy. Try again later.");
      this.sessions.delete(completed[0]);
    }
    const run = createBacktest(settings);
    const startedAt = this.clock();
    this.starting.add(user);
    try {
      const saved = { ...run.result(false), dataset: run.dataset };
      const id = await createSavedRun(user, name, "practice", settings, undefined, { startedAt: new Date(startedAt), result: saved });
      const session = { id, name, run, saved, startedAt, expiresAt: startedAt + day, reason: null, pending: Promise.resolve(), saving: false };
      this.sessions.set(user, session);
      return this.snapshot(session);
    } finally { this.starting.delete(user); }
  }

  async observe(round: BacktestRound) {
    const recordedAt = new Date(round.createdAt).getTime();
    if (!Number.isFinite(recordedAt) || recordedAt <= this.lastRoundAt) return;
    this.lastRoundAt = recordedAt;
    this.expire();
    const writes: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.reason || recordedAt < session.startedAt) continue;
      try {
        const batch = session.run.dataset.rounds;
        const play = session.run.observe(round, true) ?? null;
        const result = this.savedResult(session);
        session.pending = session.pending.then(async () => {
          if (session.reason === archiveFailureReason) return;
          await savePracticeRound({ runId: session.id, batch, rounds: [round], plays: [play] }, result);
          session.saved = result;
        }).catch(error => this.archiveFailure(session, error));
        if (session.run.stopped) this.finish(session, result.summary.stopReason ?? "The setup stopped.");
      } catch (error) {
        session.saving = true;
        session.reason = "Practice stopped after a simulation error.";
        session.pending = session.pending.then(() => this.archiveFailure(session, error)).finally(() => { session.saving = false; });
      }
      writes.push(session.pending);
    }
    await Promise.all(writes);
  }

  get(user: string) {
    this.expire();
    const session = this.sessions.get(user);
    return session ? this.snapshot(session) : null;
  }

  async stop(user: string) {
    this.expire();
    const session = this.sessions.get(user);
    if (!session) return null;
    if (!session.reason) this.finish(session, "Practice stopped.");
    await session.pending;
    return this.snapshot(session);
  }

  isRunning(user: string, id: string) {
    this.expire();
    const session = this.sessions.get(user);
    return session?.id === id && (session.reason === null || session.saving);
  }

  async shutdown() {
    for (const session of this.sessions.values()) if (!session.reason) this.finish(session, "Practice stopped when the server shut down.");
    await Promise.all([...this.sessions.values()].map(session => session.pending));
  }

  private async archiveFailure(session: PracticeSession, error: unknown) {
    console.error("Could not save practice round:", error);
    session.reason = archiveFailureReason;
    session.expiresAt = this.clock() + day;
    await interruptSavedRun(session.id, archiveFailureReason).catch(saveError => console.error("Could not close saved practice:", saveError));
  }

  private savedResult(session: PracticeSession) {
    return { ...session.run.result(false), dataset: session.run.dataset };
  }

  private snapshot(session: PracticeSession) {
    const result = session.reason === archiveFailureReason ? session.saved : { ...session.run.result(), dataset: session.run.dataset };
    return {
      runId: session.id,
      name: session.name,
      running: session.reason === null,
      stopReason: session.reason,
      result: { ...result, runId: session.id },
    };
  }
}

export const hostedPractice = new HostedPractice();
