export async function shutdownWithDeadline(
  cleanup: () => Promise<void>, exit: (code: number) => void, code: number, timeoutMs = 15_000,
) {
  // Starts before any awaited cleanup and remains active even if a resource hangs.
  let finished = false;
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    console.error("Shutdown deadline reached; remaining durable work will resume on restart");
    exit(code || 1);
  }, timeoutMs);
  try { await cleanup(); }
  catch (error) { console.error("Shutdown cleanup failed:", error); code = code || 1; }
  finally {
    clearTimeout(timer);
    if (!finished) { finished = true; exit(code); }
  }
}
