import { afterEach, expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';

vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: () =>
    Promise.resolve({
      embeds: { serviceUrl: 'https://embeds.test' },
      gifs: { klipyApiKey: 'klipy-key' },
    }),
}));

import { loadUrlPreview, resetUrlPreviews, resolveUrlPreview } from './link-preview-cache';

afterEach(() => {
  resetUrlPreviews();
});

test('a homeserver without the endpoint is asked once, not once per link', async () => {
  const urlPreview = vi.fn(() => Promise.reject(new CoreError({ code: 'unsupported' })));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await expect(loadUrlPreview({ urlPreview }, 'https://example.org/a', false)).resolves.toBeNull();
  await expect(loadUrlPreview({ urlPreview }, 'https://example.org/b', false)).resolves.toBeNull();

  expect(urlPreview).toHaveBeenCalledTimes(1);
});

test('a url the server refuses does not silence the rest', async () => {
  const urlPreview = vi.fn(({ url }: { url: string }) =>
    url.endsWith('/refused')
      ? Promise.reject(new CoreError({ code: 'unavailable' }))
      : Promise.resolve(null)
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await loadUrlPreview({ urlPreview }, 'https://example.org/refused', false);
  await loadUrlPreview({ urlPreview }, 'https://example.org/allowed', false);

  expect(urlPreview).toHaveBeenCalledTimes(2);
});

test('a client-side answer does not stand in for the homeserver one, and cannot silence it', async () => {
  const urlPreview = vi.fn(({ client }: { url: string; client?: boolean }) =>
    client ? Promise.reject(new CoreError({ code: 'unsupported' })) : Promise.resolve(null)
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await loadUrlPreview({ urlPreview }, 'https://example.org/a', true, 'https://embeds.test');
  await loadUrlPreview({ urlPreview }, 'https://example.org/a', false);

  expect(urlPreview).toHaveBeenCalledTimes(2);
});

test('a hung request resolves to nothing, frees its slot, and lets the next source answer', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const urlPreview = vi.fn(({ client }: { url: string; client?: boolean }) =>
    client ? new Promise<never>(() => undefined) : Promise.resolve(null)
  );

  const pending = resolveUrlPreview({ urlPreview }, 'https://example.org/hung', {
    client: true,
    server: true,
  });
  await vi.advanceTimersByTimeAsync(10_000);

  await expect(pending).resolves.toBeNull();
  expect(urlPreview.mock.calls).toEqual([
    [
      {
        url: 'https://example.org/hung',
        client: true,
        service: 'https://embeds.test',
        klipy_api_key: 'klipy-key',
      },
    ],
    [{ url: 'https://example.org/hung', service: null }],
  ]);
  void loadUrlPreview({ urlPreview }, 'https://example.org/hung', true, 'https://embeds.test');
  expect(urlPreview).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
});

test('a Klipy link is previewed with the Klipy key and never by the homeserver', async () => {
  const urlPreview = vi.fn((_params: { url: string; client?: boolean }) => Promise.resolve(null));
  const url = 'https://klipy.com/gifs/greetings-PSr';

  await resolveUrlPreview({ urlPreview }, url, { client: true, server: true });
  await resolveUrlPreview({ urlPreview }, url, { client: false, server: true });

  expect(urlPreview.mock.calls).toEqual([
    [{ url, client: true, service: 'https://embeds.test', klipy_api_key: 'klipy-key' }],
  ]);
});
