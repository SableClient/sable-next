const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;
const MAX_RETRY_DELAY_MS = 16_000;

export function mediaRetryDelay(attempt: number): number {
  const index = Math.max(0, Math.trunc(attempt) - 1);
  return RETRY_DELAYS_MS[index] ?? MAX_RETRY_DELAY_MS;
}

export function automaticMediaRetryDelay(attempt: number): number | null {
  return attempt > RETRY_DELAYS_MS.length ? null : mediaRetryDelay(attempt);
}
