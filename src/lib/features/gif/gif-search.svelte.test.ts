import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { GifSearch } from './gif-search.svelte';
import { gifProviders, type GifsConfig } from './providers';

const config: GifsConfig = {
  provider: 'tenor',
  proxyUrl: 'gifs.example',
  klipyApiKey: null,
  tenorApiKey: 'tenor-key',
  giphyApiKey: null,
};

const provider = gifProviders.tenor;
const apiKey = provider.apiKey(config) ?? '';

function payload(id: string): unknown {
  return {
    results: [
      {
        id,
        content_description: id,
        media_formats: {
          gif: { url: `https://media.tenor.com/${id}/full.gif`, dims: [200, 100], size: 1000 },
        },
      },
    ],
  };
}

function respond(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

const runners: GifSearch[] = [];

function runner(): GifSearch {
  const search = new GifSearch(0);
  runners.push(search);
  return search;
}

afterEach(() => {
  for (const search of runners.splice(0)) search.cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('an empty query never reaches the network', () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const search = runner();
  search.search(provider, apiKey, '   ');
  vi.runAllTimers();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(search.loading).toBe(false);
});

test('a superseded query cannot overwrite the results of the current one', async () => {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(respond(payload(url.includes('cat') ? 'cat' : 'dog')))
  );
  vi.stubGlobal('fetch', fetchMock);

  const search = runner();
  search.search(provider, apiKey, 'cat');
  search.search(provider, apiKey, 'dog');

  await vi.waitUntil(() => !search.loading);

  expect(search.results.map((gif) => gif.id)).toEqual(['dog']);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a failing response leaves the grid empty and says so', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: false, status: 429 } as Response))
  );

  const search = runner();
  search.search(provider, apiKey, 'cat');
  await vi.waitUntil(() => !search.loading);

  expect(search.failed).toBe(true);
  expect(search.results).toEqual([]);
});

test('a reset clears a previous failure so the next query starts clean', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline')))
  );

  const search = runner();
  search.search(provider, apiKey, 'cat');
  await vi.waitUntil(() => !search.loading);
  expect(search.failed).toBe(true);

  search.reset();
  flushSync();

  expect(search.failed).toBe(false);
  expect(search.results).toEqual([]);
});
