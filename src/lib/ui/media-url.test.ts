import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';

import {
  cachedMediaUrl,
  discardMediaUrl,
  holdMediaUrl,
  loadMediaUrl,
  mediaAspectRatio,
} from './media-url.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function session(accountId: string, userId: string, deviceId: string) {
  return {
    account_id: accountId,
    user_id: userId,
    device_id: deviceId,
    homeserver: 'https://example.org',
    needs_reauth: false,
  };
}

test('evicts object URLs when cached media exceeds the byte budget', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:media-${String(nextUrl++)}`);
  const core = {
    session: session('account-a', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(17 * 1024 * 1024))) },
  };

  await loadMediaUrl(core, 'mxc://example.org/first', 800, 600);
  await loadMediaUrl(core, 'mxc://example.org/second', 800, 600);

  expect(revoke).toHaveBeenCalledWith('blob:media-0');
});

test('a discarded URL is revoked and not served again until the failure expires', async () => {
  vi.useFakeTimers();
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:undecodable');
  const source = 'mxc://example.org/undecodable';
  const core = {
    session: session('account-discard', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };

  await loadMediaUrl(core, source, 96, 96);
  discardMediaUrl(core, source, 96, 96, 'blob:undecodable');

  expect(revoke).toHaveBeenCalledWith('blob:undecodable');
  expect(cachedMediaUrl(core, source, 96, 96)).toBeUndefined();
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Media unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledOnce();
});

test('does not discard a URL that has since been replaced', async () => {
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:replaced-${String(nextUrl++)}`);
  const source = 'mxc://example.org/replaced';
  const core = {
    session: session('account-replaced', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };

  await loadMediaUrl(core, source, 96, 96);
  await loadMediaUrl(core, source, 96, 96);
  discardMediaUrl(core, source, 96, 96, 'blob:replaced-0');

  expect(cachedMediaUrl(core, source, 96, 96)).toBe('blob:replaced-1');
});

test('does not share a media URL between accounts', async () => {
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:account-${String(nextUrl++)}`);
  const source = 'mxc://example.org/account-scoped';
  const accountA = {
    session: session('account-a', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };
  const accountB = {
    session: session('account-b', '@b:example.org', 'device-b'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([2]))) },
  };

  await expect(loadMediaUrl(accountA, source, 96, 96)).resolves.toBe('blob:account-0');
  await expect(loadMediaUrl(accountB, source, 96, 96)).resolves.toBe('blob:account-1');
  expect(accountB.commands.fetchMedia).toHaveBeenCalledOnce();
});

test('does not revoke an object URL a caller is still displaying', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:held-${String(nextUrl++)}`);
  const core = {
    session: session('account-held', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(17 * 1024 * 1024))) },
  };

  const release = holdMediaUrl(core, 'mxc://example.org/sidebar', 56, 56);
  const held = await loadMediaUrl(core, 'mxc://example.org/sidebar', 56, 56);
  await loadMediaUrl(core, 'mxc://example.org/timeline', 800, 600);

  expect(revoke).not.toHaveBeenCalledWith(held);

  release();
  await loadMediaUrl(core, 'mxc://example.org/later', 800, 600);

  expect(revoke).toHaveBeenCalledWith(held);
});

test('keeps the shape of a held URL however much media is measured after it', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shaped');
  vi.stubGlobal('createImageBitmap', (blob: Blob) =>
    Promise.resolve({ width: blob.size, height: 1, close: () => {} })
  );
  const core = {
    session: session('account-shaped', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: {
      fetchMedia: vi.fn((source: string) =>
        Promise.resolve(new Uint8Array(source.endsWith('wide') ? 4 : 1))
      ),
    },
  };

  const release = holdMediaUrl(core, 'mxc://example.org/wide', 0, 0);
  await loadMediaUrl(core, 'mxc://example.org/wide', 0, 0);
  for (let index = 0; index < 600; index += 1) {
    await loadMediaUrl(core, `mxc://example.org/other-${String(index)}`, 0, 0);
  }

  expect(mediaAspectRatio(core, 'mxc://example.org/wide', 0, 0)).toBe(4);
  release();
});

test('a cached URL that is held again is evicted after older ones', async () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    (blob) => `blob:recent-${String((blob as Blob).size)}`
  );
  const core = {
    session: session('account-recent', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: {
      fetchMedia: vi.fn((source: string) =>
        Promise.resolve(new Uint8Array(10 * 1024 * 1024 + Number(source.slice(-1))))
      ),
    },
  };

  const first = await loadMediaUrl(core, 'mxc://example.org/recent-1', 800, 600);
  const second = await loadMediaUrl(core, 'mxc://example.org/recent-2', 800, 600);
  await loadMediaUrl(core, 'mxc://example.org/recent-3', 800, 600);
  holdMediaUrl(core, 'mxc://example.org/recent-1', 800, 600)();
  await loadMediaUrl(core, 'mxc://example.org/recent-4', 800, 600);

  expect(revoke).toHaveBeenCalledWith(second);
  expect(revoke).not.toHaveBeenCalledWith(first);
});

test('revokes the URL it replaces when a key is fetched twice', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:replaced-${String(nextUrl++)}`);
  const core = {
    session: session('account-replaced', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };
  const source = 'mxc://example.org/notification-avatar';

  const first = await loadMediaUrl(core, source, 96, 96);
  const second = await loadMediaUrl(core, source, 96, 96);

  expect(second).not.toBe(first);
  expect(revoke).toHaveBeenCalledWith(first);
});

test('holds media requests at six in flight', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:gated');
  const settlers: (() => void)[] = [];
  const core = {
    session: session('account-gated', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: {
      fetchMedia: vi.fn(
        () =>
          new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
            settlers.push(() => {
              resolve(new Uint8Array([1]));
            });
          })
      ),
    },
  };

  const requests = Array.from({ length: 8 }, (_, index) =>
    loadMediaUrl(core, `mxc://example.org/gated-${String(index)}`, 96, 96)
  );

  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(6);

  for (let settled = 0; settled < requests.length; settled += 1) {
    await vi.waitFor(() => {
      expect(settlers.length).toBeGreaterThan(settled);
    });
    settlers[settled]?.();
  }
  await Promise.all(requests);

  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(8);
});

test('never revokes the URL it is about to return', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:published-${String(nextUrl++)}`);
  const core = {
    session: session('account-published', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(17 * 1024 * 1024))) },
  };

  holdMediaUrl(core, 'mxc://example.org/thumbnail', 56, 56);
  await loadMediaUrl(core, 'mxc://example.org/thumbnail', 56, 56);
  const original = await loadMediaUrl(core, 'mxc://example.org/thumbnail', 0, 0);

  expect(revoke).not.toHaveBeenCalledWith(original);
});

test('lets a failed source be fetched again once its backoff has elapsed', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:recovered');
  const core = {
    session: session('account-recovered', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: {
      fetchMedia: vi
        .fn<() => Promise<Uint8Array<ArrayBuffer>>>()
        .mockRejectedValueOnce(new Error('Media unavailable'))
        .mockResolvedValue(new Uint8Array([1])),
    },
  };
  const source = 'mxc://remote.example/cold-avatar';

  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow();
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow();
  expect(core.commands.fetchMedia).toHaveBeenCalledOnce();

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);

  await expect(loadMediaUrl(core, source, 96, 96)).resolves.toBe('blob:recovered');
});

test('does not let stalled media requests block later media forever', async () => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:after-stall');
  const core = {
    session: session('account-stalled', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: {
      fetchMedia: vi.fn(() => new Promise<Uint8Array<ArrayBuffer>>(() => {})),
    },
  };

  const requests = Array.from({ length: 7 }, (_, index) =>
    loadMediaUrl(core, `mxc://example.org/stalled-${String(index)}`, 96, 96)
  );
  void Promise.allSettled(requests);

  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(7);
});

test('keeps a download alive while it reports progress', async () => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:large');
  const listeners = new Set<(event: CoreEvent) => void>();
  let finish: (bytes: Uint8Array<ArrayBuffer>) => void = () => {};
  const source = 'mxc://example.org/large';
  const core = {
    session: session('account-large', '@a:example.org', 'device-a'),
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commands: {
      fetchMedia: vi.fn(
        () =>
          new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
            finish = resolve;
          })
      ),
    },
  };
  const progress = (current: number): void => {
    for (const listener of listeners) {
      listener({ type: 'media_progress', source, current, total: 100 });
    }
  };

  const request = loadMediaUrl(core, source, 0, 0);
  for (const current of [20, 40, 60, 80]) {
    await vi.advanceTimersByTimeAsync(20_000);
    progress(current);
  }
  finish(new Uint8Array(100));

  await expect(request).resolves.toBe('blob:large');
  expect(listeners.size).toBe(0);
});
