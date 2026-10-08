import { expect, test, vi } from 'vitest';

import { installFirefoxFetchLimit, limitAfterNetworkFailures } from './adaptive-fetch';

const HOST = 'https://hs.example';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<Response>((done) => {
    resolve = () => {
      done(new Response('{}'));
    };
  });
  return { promise, resolve };
}

function trackingFetch(failing: () => boolean) {
  const state = { inFlight: 0, peak: 0, pending: [] as (() => void)[] };
  const base = vi.fn((_input: RequestInfo | URL) => {
    if (failing()) return Promise.reject(new TypeError('NetworkError'));
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    const call = deferred();
    state.pending.push(() => {
      state.inFlight -= 1;
      call.resolve();
    });
    return call.promise;
  });
  return { base: base as unknown as typeof fetch, state };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function tripLimit(limited: typeof fetch) {
  for (let i = 0; i < 5; i++) await limited(`${HOST}/a`).catch(() => undefined);
}

test('does not limit an origin that has not failed', async () => {
  const { base, state } = trackingFetch(() => false);
  const limited = limitAfterNetworkFailures(base);

  const calls = [1, 2, 3, 4].map((i) => limited(`${HOST}/${i}`));
  await settle();
  expect(state.peak).toBe(4);
  state.pending.forEach((finish) => {
    finish();
  });
  await Promise.all(calls);
});

test('serialises requests once five in a row have failed', async () => {
  let failing = true;
  const { base, state } = trackingFetch(() => failing);
  const limited = limitAfterNetworkFailures(base);
  await tripLimit(limited);
  failing = false;

  const calls = [1, 2, 3].map((i) => limited(`${HOST}/${i}`));
  await settle();
  expect(state.inFlight).toBe(1);

  while (state.pending.length > 0) {
    state.pending.shift()?.();
    await settle();
  }
  await Promise.all(calls);
  expect(state.peak).toBe(1);
});

test('keeps long polls out of the limit', async () => {
  let failing = true;
  const { base, state } = trackingFetch(() => failing);
  const limited = limitAfterNetworkFailures(base);
  await tripLimit(limited);
  failing = false;

  const polls = [
    limited(`${HOST}/sync?timeout=30000`),
    limited(`${HOST}/sync?timeout=30000`),
    limited(`${HOST}/versions`),
  ];
  await settle();
  expect(state.inFlight).toBe(3);
  state.pending.forEach((finish) => {
    finish();
  });
  await Promise.all(polls);
});

test('another origin is not limited by the first one failing', async () => {
  const { base, state } = trackingFetch(() => false);
  const failing = vi.fn((input: string) =>
    input.startsWith(HOST) ? Promise.reject(new TypeError('NetworkError')) : base(input)
  );
  const limited = limitAfterNetworkFailures(failing as unknown as typeof fetch);
  await tripLimit(limited);

  const calls = [1, 2, 3].map((i) => limited(`https://public.example/${i}`));
  await settle();
  expect(state.peak).toBe(3);
  state.pending.forEach((finish) => {
    finish();
  });
  await Promise.all(calls);
});

test('an aborted request is not a network failure', async () => {
  let aborting = true;
  const { base, state } = trackingFetch(() => false);
  const limited = limitAfterNetworkFailures((input: RequestInfo | URL) =>
    aborting ? Promise.reject(new DOMException('aborted', 'AbortError')) : base(input)
  );
  for (let i = 0; i < 6; i++) await limited(`${HOST}/a`).catch(() => undefined);
  aborting = false;

  const calls = [1, 2].map((i) => limited(`${HOST}/${i}`));
  await settle();
  expect(state.peak).toBe(2);
  state.pending.forEach((finish) => {
    finish();
  });
  await Promise.all(calls);
});

test('lifts the limit after enough successes', async () => {
  let failing = true;
  const { base, state } = trackingFetch(() => failing);
  const limited = limitAfterNetworkFailures(base);
  await tripLimit(limited);
  failing = false;

  for (let i = 0; i < 25; i++) {
    const call = limited(`${HOST}/ok`);
    await settle();
    state.pending.shift()?.();
    await call;
  }

  const calls = [1, 2, 3].map((i) => limited(`${HOST}/${i}`));
  await settle();
  expect(state.inFlight).toBe(3);
  state.pending.forEach((finish) => {
    finish();
  });
  await Promise.all(calls);
});

test.each([
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0', true],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36', false],
])('wraps fetch only on Firefox: %s', (userAgent, wrapped) => {
  const original = vi.fn() as unknown as typeof fetch;
  const scope = { fetch: original, navigator: { userAgent } };
  installFirefoxFetchLimit(scope);
  expect(scope.fetch !== original).toBe(wrapped);
});
