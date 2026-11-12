const STALL_AFTER_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 5_000;

export interface StallMonitor {
  /** Starts the clock on a request and returns what to call once it settles. */
  watch(): () => void;
  /** The core answered something, so it is not stalled. */
  responsive(): void;
  reset(): void;
}

/**
 * A slow request alone proves nothing, so `probe` asks the core for a cheap answer and only
 * its silence counts as a stall. Whoever receives that answer calls `responsive`.
 */
export function createStallMonitor(
  probe: () => void,
  report: (stalled: boolean) => void
): StallMonitor {
  const overdue = new Set<symbol>();
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;

  function set(next: boolean): void {
    if (stalled === next) return;
    stalled = next;
    report(next);
  }

  function clearProbe(): void {
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    probeTimer = undefined;
  }

  function scheduleProbe(delay = 0): void {
    if (overdue.size === 0 || probeTimer !== undefined) return;
    probeTimer = setTimeout(() => {
      probeTimer = undefined;
      if (overdue.size === 0) return;

      probe();
      probeTimer = setTimeout(() => {
        probeTimer = undefined;
        set(true);
        scheduleProbe(PROBE_INTERVAL_MS);
      }, PROBE_TIMEOUT_MS);
    }, delay);
  }

  return {
    watch() {
      const request = Symbol();
      const timer = setTimeout(() => {
        overdue.add(request);
        scheduleProbe();
      }, STALL_AFTER_MS);
      return () => {
        clearTimeout(timer);
        overdue.delete(request);
        if (overdue.size > 0) return;
        clearProbe();
        set(false);
      };
    },

    responsive() {
      if (overdue.size === 0) return;
      clearProbe();
      set(false);
      scheduleProbe(PROBE_INTERVAL_MS);
    },

    reset() {
      clearProbe();
      overdue.clear();
      set(false);
    },
  };
}
