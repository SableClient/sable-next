import { afterEach, expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';

import {
  cachedMediaUrl,
  discardMediaUrl,
  holdMediaUrl,
  loadMediaUrl,
  mediaAspectRatio,
  retryMediaUrl,
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

test('encrypted media shares one request and URL across display sizes', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:encrypted-sizes');
  const source = JSON.stringify({ url: 'mxc://example.org/encrypted-sizes' });
  const core = {
    session: session('account-encrypted-sizes', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };

  const urls = await Promise.all([
    loadMediaUrl(core, source, 96, 96),
    loadMediaUrl(core, source, 128, 128),
    loadMediaUrl(core, source, 0, 0),
  ]);

  expect(core.commands.fetchMedia).toHaveBeenCalledOnce();
  expect(urls).toEqual(Array(3).fill('blob:encrypted-sizes'));
  expect(cachedMediaUrl(core, source, 512, 384)).toBe(urls[0]);
});

test('plain media keeps server thumbnails separate from the original', async () => {
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:plain-sizes-${nextUrl++}`);
  const core = {
    session: session('account-plain-sizes', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };

  const urls = await Promise.all([
    loadMediaUrl(core, 'mxc://example.org/plain-sizes', 96, 96),
    loadMediaUrl(core, 'mxc://example.org/plain-sizes', 128, 128),
    loadMediaUrl(core, 'mxc://example.org/plain-sizes', 0, 0),
  ]);

  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(3);
  expect(new Set(urls).size).toBe(3);
});

test('an encrypted URL stays held until consumers at every size release it', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:encrypted-holds');
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const source = JSON.stringify({ url: 'mxc://example.org/encrypted-holds' });
  const core = {
    session: session('account-encrypted-holds', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(40 * 1024 * 1024))) },
  };
  const releasePreview = holdMediaUrl(core, source, 96, 96);
  const releaseOriginal = holdMediaUrl(core, source, 0, 0);
  const url = await loadMediaUrl(core, source, 96, 96);

  releasePreview();
  await Promise.resolve();
  expect(revoke).not.toHaveBeenCalledWith(url);

  releaseOriginal();
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledWith(url);
  expect(cachedMediaUrl(core, source, 96, 96)).toBeUndefined();
  expect(cachedMediaUrl(core, source, 0, 0)).toBeUndefined();
});

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

test('still evicts old small previews when the entry budget is exceeded', async () => {
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:entry-budget-${nextUrl++}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const core = {
    session: session('account-entry-budget', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };
  const source = (index: number) => `mxc://example.org/entry-budget-${String(index)}`;
  const first = await loadMediaUrl(core, source(0), 144, 144);
  for (let index = 1; index <= 512; index += 1) {
    await loadMediaUrl(core, source(index), 144, 144);
  }

  expect(revoke).toHaveBeenCalledWith(first);
  expect(cachedMediaUrl(core, source(0), 144, 144)).toBeUndefined();
  expect(cachedMediaUrl(core, source(512), 144, 144)).toBeDefined();
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

test('enforces the byte budget when the last media consumer releases its hold', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:release-${nextUrl++}`);
  const core = {
    session: session('account-release', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(40 * 1024 * 1024))) },
  };
  const source = 'mxc://example.org/large-video';
  const first = holdMediaUrl(core, source, 0, 0);
  const last = holdMediaUrl(core, source, 0, 0);
  const url = await loadMediaUrl(core, source, 0, 0);

  first();
  await Promise.resolve();
  expect(revoke).not.toHaveBeenCalledWith(url);
  last();
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledWith(url);
  expect(cachedMediaUrl(core, source, 0, 0)).toBeUndefined();
});

test('a hold released and taken back in one update keeps its url past the cap', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:rehold-${nextUrl++}`);
  const core = {
    session: session('account-rehold', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(8))) },
  };
  const holds = Array.from({ length: 520 }, (_, index) =>
    holdMediaUrl(core, `mxc://example.org/emote-${String(index)}`, 0, 0)
  );
  await Promise.all(
    holds.map((_, index) => loadMediaUrl(core, `mxc://example.org/emote-${String(index)}`, 0, 0))
  );
  const source = 'mxc://example.org/emote-519';
  const url = cachedMediaUrl(core, source, 0, 0);

  holds[519]();
  holds[519] = holdMediaUrl(core, source, 0, 0);
  await Promise.resolve();

  expect(revoke).not.toHaveBeenCalledWith(url);
  expect(cachedMediaUrl(core, source, 0, 0)).toBe(url);
  for (const release of holds) release();
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

test('revokes a replaced URL once the last caller holding it lets go', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:displaced-${String(nextUrl++)}`);
  const core = {
    session: session('account-displaced', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };
  const source = 'mxc://example.org/refetched';

  const release = holdMediaUrl(core, source, 0, 0);
  const first = await loadMediaUrl(core, source, 0, 0);
  const second = await loadMediaUrl(core, source, 0, 0);

  expect(revoke).not.toHaveBeenCalledWith(first);

  release();

  expect(revoke).toHaveBeenCalledWith(first);
  expect(revoke).not.toHaveBeenCalledWith(second);
});

test('disk-cache reads reach the core while six downloads are stalled', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:disk-cached');
  const cachedSource = 'mxc://example.org/disk-cached-sticker';
  const finish: (() => void)[] = [];
  const core = {
    session: session('account-disk-cache', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: {
      fetchMedia: vi.fn((source: string) =>
        source === cachedSource
          ? Promise.resolve(new Uint8Array([1]))
          : new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
              finish.push(() => {
                resolve(new Uint8Array([1]));
              });
            })
      ),
    },
  };
  const downloads = Array.from({ length: 6 }, (_, index) =>
    loadMediaUrl(core, `mxc://example.org/disk-cache-stalled-${String(index)}`, 144, 144)
  );
  void Promise.allSettled(downloads);
  const cached = loadMediaUrl(core, cachedSource, 144, 144);
  void cached.catch(() => {});

  try {
    expect(core.commands.fetchMedia).toHaveBeenCalledWith(cachedSource, 144, 144);
    await expect(cached).resolves.toBe('blob:disk-cached');
  } finally {
    for (const resolve of finish) resolve();
    await Promise.allSettled(downloads);
  }
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

test('does not impose a deadline on requests queued or downloading in the core', async () => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:large');
  let finish: (bytes: Uint8Array<ArrayBuffer>) => void = () => {};
  const source = 'mxc://example.org/large';
  const core = {
    session: session('account-large', '@a:example.org', 'device-a'),
    commands: {
      fetchMedia: vi.fn(
        () =>
          new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
            finish = resolve;
          })
      ),
    },
  };
  const request = loadMediaUrl(core, source, 0, 0);
  void request.catch(() => {});
  await vi.advanceTimersByTimeAsync(80_000);
  finish(new Uint8Array(100));

  await expect(request).resolves.toBe('blob:large');
});

test('a media server the core refuses is not asked again until it says so, even on retry', async () => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:refused');
  const fetchMedia = vi
    .fn<() => Promise<Uint8Array<ArrayBuffer>>>()
    .mockRejectedValueOnce(
      new CoreError({ code: 'media_server_unavailable', retry_after_ms: 60_000 })
    )
    .mockResolvedValue(new Uint8Array([1]));
  const core = {
    session: session('account-refused', '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia },
  };
  const source = 'mxc://dead.example/refused';

  await expect(loadMediaUrl(core, source, 0, 0)).rejects.toThrow();
  await expect(retryMediaUrl(core, source, 0, 0)).rejects.toThrow();
  expect(fetchMedia).toHaveBeenCalledOnce();

  vi.advanceTimersByTime(60_001);

  await expect(retryMediaUrl(core, source, 0, 0)).resolves.toBe('blob:refused');
  expect(fetchMedia).toHaveBeenCalledTimes(2);
});

function failingCore(accountId: string, fetchMedia: () => Promise<Uint8Array<ArrayBuffer>>) {
  return {
    session: session(accountId, '@a:example.org', 'device-a'),
    subscribeEvents: () => () => {},
    commands: { fetchMedia: vi.fn(fetchMedia) },
  };
}

test('each failure of a source holds it for twice as long as the last', async () => {
  vi.useFakeTimers();
  const core = failingCore('account-doubling', () => Promise.reject(new Error('Unavailable')));
  const source = 'mxc://dead.example/doubling';

  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1_999);
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Media unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(1);
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(3_999);
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Media unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(1);
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(3);
});

test('callers sharing a request count as one failure', async () => {
  vi.useFakeTimers();
  const core = failingCore('account-shared-failure', () =>
    Promise.reject(new Error('Unavailable'))
  );
  const source = 'mxc://dead.example/shared';

  await Promise.allSettled([
    loadMediaUrl(core, source, 96, 96),
    loadMediaUrl(core, source, 96, 96),
    loadMediaUrl(core, source, 96, 96),
  ]);
  expect(core.commands.fetchMedia).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(2_000);
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(2);
});

test('a manual retry asks again whatever the hold, and starts the count over', async () => {
  vi.useFakeTimers();
  const core = failingCore('account-manual', () => Promise.reject(new Error('Unavailable')));
  const source = 'mxc://dead.example/manual';

  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Unavailable');
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Unavailable');

  await expect(retryMediaUrl(core, source, 96, 96)).rejects.toThrow('Unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(3);

  await vi.advanceTimersByTimeAsync(2_000);
  await expect(loadMediaUrl(core, source, 96, 96)).rejects.toThrow('Unavailable');
  expect(core.commands.fetchMedia).toHaveBeenCalledTimes(4);
});

test('a success forgets the failures', async () => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recovered-after-failures');
  const fetch = vi
    .fn<() => Promise<Uint8Array<ArrayBuffer>>>()
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce(new Uint8Array([1]))
    .mockRejectedValue(new Error('Unavailable'));
  const core = failingCore('account-forgiven', fetch);
  const source = 'mxc://flaky.example/forgiven';

  await expect(loadMediaUrl(core, source, 0, 0)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(loadMediaUrl(core, source, 0, 0)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(4_000);
  await expect(loadMediaUrl(core, source, 0, 0)).resolves.toBe('blob:recovered-after-failures');

  const other = 'mxc://flaky.example/forgiven-again';
  await expect(loadMediaUrl(core, other, 0, 0)).rejects.toThrow('Unavailable');
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(loadMediaUrl(core, other, 0, 0)).rejects.toThrow('Unavailable');
  expect(fetch).toHaveBeenCalledTimes(5);
});
