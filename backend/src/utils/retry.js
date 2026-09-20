export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry(operation, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 400,
    timeoutMs = 15000,
    onRetry = null,
    label = "operation"
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await Promise.race([
        operation({ attempt, signal: controller.signal }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);

      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      if (attempt >= retries) {
        throw error;
      }

      // Exponential backoff, and if the failure was a 429 with a
      // Retry-After header (seconds), respect it instead of guessing —
      // the store is telling us exactly how long to wait.
      const retryAfterMs = Number(error?.retryAfterSeconds) > 0
        ? Number(error.retryAfterSeconds) * 1000
        : null;
      const delayMs = retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1);

      if (onRetry) onRetry({ attempt, error, delayMs });
      await sleep(delayMs);
    }
  }

  throw lastError;
}