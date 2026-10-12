import { Worker } from "node:worker_threads";
import type { runBacktest } from "./engine.js";

type Input = Parameters<typeof runBacktest>[0];
type Result = ReturnType<typeof runBacktest>;
type Job = { input: Input; resolve: (result: Result) => void; reject: (error: Error) => void;
  signal?: AbortSignal; cancel: () => void; timer?: ReturnType<typeof setTimeout>; worker?: Worker; finished: boolean };

export class BacktestRunner {
  private queue: Job[] = [];
  private active = new Set<Job>();
  private stopped = false;
  constructor(private timeoutMs = 20_000) {}

  run(input: Input, signal?: AbortSignal): Promise<Result> {
    if (this.stopped) return Promise.reject(new Error("Backtests are stopping"));
    if (signal?.aborted) return Promise.reject(new Error("Backtest cancelled"));
    if (this.queue.length >= 8) return Promise.reject(new Error("Backtest service is busy; retry later"));
    return new Promise((resolve, reject) => {
      const job: Job = { input, resolve, reject, signal, finished: false, cancel: () => this.finish(job, new Error("Backtest cancelled")) };
      job.timer = setTimeout(() => this.finish(job, new Error("Backtest exceeded its time limit")), this.timeoutMs);
      signal?.addEventListener("abort", job.cancel, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump() {
    while (!this.stopped && this.active.size < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.active.add(job);
      const source = import.meta.url.endsWith(".ts");
      try {
        job.worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          (async () => {
            if (workerData.source) { const { register } = await import('tsx/esm/api'); register(); }
            const { runBacktest } = await import(workerData.module);
            parentPort.postMessage(runBacktest(workerData.input));
          })().catch(error => { throw error; });
        `, { eval: true, workerData: { input: job.input, source, module: new URL(source ? "./engine.ts" : "./engine.js", import.meta.url).href } });
        job.worker.once("message", result => this.finish(job, undefined, result));
        job.worker.once("error", error => this.finish(job, error instanceof Error ? error : new Error(String(error))));
        job.worker.once("exit", code => { if (!job.finished) this.finish(job, new Error(`Backtest worker exited (${code})`)); });
      } catch (error) { this.finish(job, error instanceof Error ? error : new Error(String(error))); }
    }
  }

  private finish(job: Job, error?: Error, result?: Result) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.cancel);
    this.queue = this.queue.filter(item => item !== job);
    const terminated = job.worker?.terminate() || Promise.resolve();
    void terminated.catch(() => undefined).finally(() => {
      this.active.delete(job);
      if (error) job.reject(error); else job.resolve(result!);
      this.pump();
    });
  }

  async shutdown() {
    this.stopped = true;
    const jobs = [...this.queue, ...this.active];
    for (const job of jobs) this.finish(job, new Error("Backtests are stopping"));
    await Promise.allSettled(jobs.map(job => job.worker?.terminate()));
  }
}
export const backtestRunner = new BacktestRunner();
