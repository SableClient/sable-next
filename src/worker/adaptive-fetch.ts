const ENTER_AFTER_FAILURES = 5;
const LEAVE_AFTER_SUCCESSES = 25;
const LONG_POLL_MS = 10_000;

type Fetch = typeof fetch;

interface OriginState {
  failures: number;
  successes: number;
  limited: boolean;
  active: number;
  queue: (() => void)[];
}

function requestUrl(input: Parameters<Fetch>[0]): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
}

function isLongPoll(url: URL): boolean {
  return Number(url.searchParams.get('timeout')) >= LONG_POLL_MS;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function limitAfterNetworkFailures(base: Fetch): Fetch {
  const origins = new Map<string, OriginState>();

  function stateFor(origin: string): OriginState {
    let state = origins.get(origin);
    if (state === undefined) {
      state = { failures: 0, successes: 0, limited: false, active: 0, queue: [] };
      origins.set(origin, state);
    }
    return state;
  }

  function drain(state: OriginState): void {
    for (const wake of state.queue.splice(0)) {
      state.active += 1;
      wake();
    }
  }

  async function acquire(state: OriginState): Promise<boolean> {
    if (!state.limited) return false;
    if (state.active === 0) {
      state.active = 1;
      return true;
    }
    await new Promise<void>((resolve) => state.queue.push(resolve));
    return true;
  }

  function release(state: OriginState): void {
    state.active -= 1;
    if (!state.limited) {
      drain(state);
      return;
    }
    const next = state.queue.shift();
    if (next !== undefined) {
      state.active += 1;
      next();
    }
  }

  function succeeded(state: OriginState): void {
    state.failures = 0;
    state.successes += 1;
    if (state.limited && state.successes >= LEAVE_AFTER_SUCCESSES) {
      state.limited = false;
      drain(state);
    }
  }

  function failed(state: OriginState): void {
    state.successes = 0;
    state.failures += 1;
    if (state.failures >= ENTER_AFTER_FAILURES) state.limited = true;
  }

  return async (input, init) => {
    const url = requestUrl(input);
    if (url === null) return base(input, init);

    const state = stateFor(url.origin);
    const held = isLongPoll(url) ? false : await acquire(state);
    try {
      const response = await base(input, init);
      succeeded(state);
      return response;
    } catch (error) {
      if (!isAbort(error)) failed(state);
      throw error;
    } finally {
      if (held) release(state);
    }
  };
}

export function installFirefoxFetchLimit(scope: {
  fetch: Fetch;
  navigator: { userAgent: string };
}): void {
  if (!scope.navigator.userAgent.includes('Firefox')) return;
  scope.fetch = limitAfterNetworkFailures(scope.fetch.bind(scope));
}
