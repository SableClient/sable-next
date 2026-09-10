import { afterEach, expect, test, vi } from 'vitest';

import { holdMediaUrl, loadMediaUrl } from './media-url.js';

afterEach(() => {
  vi.restoreAllMocks();
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
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(17 * 1024 * 1024))) },
  };

  await loadMediaUrl(core, 'mxc://example.org/first', 800, 600);
  await loadMediaUrl(core, 'mxc://example.org/second', 800, 600);

  expect(revoke).toHaveBeenCalledWith('blob:media-0');
});

test('does not share a media URL between accounts', async () => {
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:account-${String(nextUrl++)}`);
  const source = 'mxc://example.org/account-scoped';
  const accountA = {
    session: session('account-a', '@a:example.org', 'device-a'),
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };
  const accountB = {
    session: session('account-b', '@b:example.org', 'device-b'),
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

test('revokes the URL it replaces when a key is fetched twice', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:replaced-${String(nextUrl++)}`);
  const core = {
    session: session('account-replaced', '@a:example.org', 'device-a'),
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
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(17 * 1024 * 1024))) },
  };

  holdMediaUrl(core, 'mxc://example.org/thumbnail', 56, 56);
  await loadMediaUrl(core, 'mxc://example.org/thumbnail', 56, 56);
  const original = await loadMediaUrl(core, 'mxc://example.org/thumbnail', 0, 0);

  expect(revoke).not.toHaveBeenCalledWith(original);
});
