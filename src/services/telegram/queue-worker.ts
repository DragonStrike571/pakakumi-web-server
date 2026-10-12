import { runBackgroundTask } from "../../utils/background-task.js";

export function runQueueWorker(
  processNext: () => unknown | Promise<unknown>,
  recover: () => void,
): void {
  runBackgroundTask("Telegram message queue", async () => {
    try {
      await processNext();
    } catch (error) {
      recover();
      throw error;
    }
  });
}
