/**
 * Reads from testnet that give up on time and try again (T158).
 *
 * On 2026-10-15 the public Soroban RPC answered 502, 503 and 504 for an hour, and one read hung for about forty
 * minutes: long enough for an escrow's arbiter window to close with the verdict never asked (`X-7`). A read here
 * stops waiting after `timeoutMs`, and a network failure is tried again a few times; anything else (a receipt that
 * does not check out, a dispute that is not open) fails at once, as before.
 *
 * Only for reads. A write is never retried here: sent twice, it could act twice.
 */
import { AgentPassError, isAgentPassError } from "@agentpass/core";

export interface RetryOptions {
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Told about each failed attempt that will be tried again. */
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

const TRANSIENT = /status code (5\d\d|429)|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network error|timed out/i;

/** Whether an error is the network's, worth another try: a 5xx or 429, a dropped connection, or our own timeout. */
export function isTransient(error: unknown): boolean {
  if (isAgentPassError(error)) return error.code === "NetworkError";
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? "")}` : String(error);
  return TRANSIENT.test(text);
}

/**
 * `read()`, given at most `timeoutMs` per attempt and `attempts` tries for network failures.
 *
 * @throws AgentPassError `NetworkError` when every attempt failed on the network; any other error as it came
 */
export async function withRetry<T>(label: string, read: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const delayMs = options.delayMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AgentPassError("NetworkError", `${label} timed out after ${timeoutMs} ms`, { details: { label, attempt } })), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (!isTransient(error)) throw error;
      last = error;
      if (attempt < attempts) {
        options.onRetry?.(attempt, error);
        await sleep(delayMs);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw new AgentPassError("NetworkError", `${label} failed on the network ${attempts} times`, { cause: last, details: { label, attempts } });
}
