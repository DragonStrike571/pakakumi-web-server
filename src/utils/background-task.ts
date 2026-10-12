/** Contain failures from tasks launched by event listeners or timers. */
export function runBackgroundTask(
  name: string,
  task: () => unknown | Promise<unknown>,
): void {
  void Promise.resolve().then(task).catch((error: unknown) => {
    console.error(`❌ ${name} failed:`, error);
  });
}
