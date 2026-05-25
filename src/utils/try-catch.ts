type TryCatchOptions = {
  retries?: number;
  retryDelay?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
};

type TryCatchResult<T> =
  | { data: T; error: null }
  | { data: null; error: unknown };

export async function trycatch<T>(
  fn: () => Promise<T>,
  options?: TryCatchOptions,
): Promise<TryCatchResult<T>> {
  const {
    retries = 0,
    retryDelay = 100,
    shouldRetry = () => true,
    onRetry,
  } = options || {};

  let attempts = 0;

  while (true) {
    try {
      const data = await fn();
      return { data, error: null };
    } catch (error) {
      attempts++;

      // If we've exhausted retries or the error shouldn't be retried, fail
      if (attempts > retries || !shouldRetry(error)) {
        return { data: null, error };
      }

      if (onRetry) {
        onRetry(error, attempts);
      }

      // Wait for the delay before retrying
      if (retryDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
}
