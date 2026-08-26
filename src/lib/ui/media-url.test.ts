import { afterEach, expect, test, vi } from 'vitest';

import { holdMediaUrl, loadMediaUrl } from './media-url.js';

afterEach(() => {
  vi.restoreAllMocks();
});

test('evicts object URLs when cached media exceeds the byte budget', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:media-${String(nextUrl++)}`);
  const core = {
    session: { account_id: 'account-a', user_id: '@a:example.org', device_id: 'device-a' },
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
    session: { account_id: 'account-a', user_id: '@a:example.org', device_id: 'device-a' },
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array([1]))) },
  };
  const accountB = {
    session: { account_id: 'account-b', user_id: '@b:example.org', device_id: 'device-b' },
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
    session: { account_id: 'account-held', user_id: '@a:example.org', device_id: 'device-a' },
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

test('never revokes the URL it is about to return', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:published-${String(nextUrl++)}`);
  const core = {
    session: { account_id: 'account-published', user_id: '@a:example.org', device_id: 'device-a' },
    commands: { fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(17 * 1024 * 1024))) },
  };

  holdMediaUrl(core, 'mxc://example.org/thumbnail', 56, 56);
  await loadMediaUrl(core, 'mxc://example.org/thumbnail', 56, 56);
  const original = await loadMediaUrl(core, 'mxc://example.org/thumbnail', 0, 0);

  expect(revoke).not.toHaveBeenCalledWith(original);
});
