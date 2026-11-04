import { afterEach, expect, test, vi } from 'vitest';
import { discoverAccountConfig } from './account-discovery.js';

afterEach(() => vi.unstubAllGlobals());

test('deduplicates discovery and sends no credentials', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ branding: { appName: 'Acme' } })));
  vi.stubGlobal('fetch', fetch);
  const [first, second] = await Promise.all([
    discoverAccountConfig('one.example'),
    discoverAccountConfig('one.example'),
  ]);
  expect(first).toEqual({ branding: { appName: 'Acme' } });
  expect(second).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-cache' });
});

test('distinguishes absence from invalid documents and temporary failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response('[]'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('{}'))
  );
  expect(await discoverAccountConfig('missing.example')).toBeNull();
  expect(await discoverAccountConfig('invalid.example')).toBeUndefined();
  expect(await discoverAccountConfig('offline.example')).toBeUndefined();
  expect(await discoverAccountConfig('empty.example')).toEqual({});
});
