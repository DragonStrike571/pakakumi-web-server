import { createBacktest, type BacktestRound, type BacktestSettings } from "./engine.js";

const day = 24 * 60 * 60 * 1000;
const capacity = 100;

interface PracticeSession {
  name: string;
  run: ReturnType<typeof createBacktest>;
  startedAt: number;
  expiresAt: number;
  reason: string | null;
}

export class HostedPractice {
  private readonly sessions = new Map<string, PracticeSession>();
  private lastRoundAt = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  private expire() {
    const now = this.clock();
    for (const [user, session] of this.sessions) {
      if (now < session.expiresAt) continue;
      if (session.reason) this.sessions.delete(user);
      else this.finish(session, "The 24-hour practice limit was reached.");
    }
  }

  private finish(session: PracticeSession, reason: string) {
    session.reason = reason;
    session.expiresAt = this.clock() + day;
  }

  start(user: string, name: string, settings: BacktestSettings) {
    this.expire();
    if (this.sessions.get(user)?.reason === null) throw new Error("A practice session is already running.");
    if (!this.sessions.has(user) && this.sessions.size >= capacity) {
      const completed = [...this.sessions].find(([, session]) => session.reason !== null);
      if (!completed) throw new Error("The practice server is busy. Try again later.");
      this.sessions.delete(completed[0]);
    }
    const run = createBacktest(settings);
    const startedAt = this.clock();
    const session = { name, run, startedAt, expiresAt: startedAt + day, reason: null };
    this.sessions.delete(user);
    this.sessions.set(user, session);
    return this.snapshot(session);
  }

  observe(round: BacktestRound) {
    const recordedAt = new Date(round.createdAt).getTime();
    if (!Number.isFinite(recordedAt) || recordedAt <= this.lastRoundAt) return;
    this.lastRoundAt = recordedAt;
    this.expire();
    for (const session of this.sessions.values()) {
      if (session.reason || recordedAt < session.startedAt) continue;
      try {
        session.run.observe(round);
        if (session.run.stopped) this.finish(session, session.run.result().summary.stopReason ?? "The setup stopped.");
      } catch (error) {
        this.finish(session, error instanceof Error ? error.message : "Practice stopped after an error.");
      }
    }
  }

  get(user: string) {
    this.expire();
    const session = this.sessions.get(user);
    return session ? this.snapshot(session) : null;
  }

  stop(user: string) {
    this.expire();
    const session = this.sessions.get(user);
    if (!session) return null;
    if (!session.reason) this.finish(session, "Practice stopped.");
    return this.snapshot(session);
  }

  private snapshot(session: PracticeSession) {
    return {
      name: session.name,
      running: session.reason === null,
      stopReason: session.reason,
      result: { ...session.run.result(), dataset: session.run.dataset },
    };
  }
}

export const hostedPractice = new HostedPractice();
