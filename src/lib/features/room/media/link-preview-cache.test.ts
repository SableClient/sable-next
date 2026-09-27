import { afterEach, expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';

import { loadUrlPreview, resetUrlPreviews } from './link-preview-cache';

afterEach(() => {
  resetUrlPreviews();
});

test('a homeserver without the endpoint is asked once, not once per link', async () => {
  const urlPreview = vi.fn(() => Promise.reject(new CoreError({ code: 'unsupported' })));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await expect(loadUrlPreview({ urlPreview }, 'https://example.org/a')).resolves.toBeNull();
  await expect(loadUrlPreview({ urlPreview }, 'https://example.org/b')).resolves.toBeNull();

  expect(urlPreview).toHaveBeenCalledTimes(1);
});

test('a url the server refuses does not silence the rest', async () => {
  const urlPreview = vi.fn((url: string) =>
    url.endsWith('/refused')
      ? Promise.reject(new CoreError({ code: 'unavailable' }))
      : Promise.resolve(null)
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await loadUrlPreview({ urlPreview }, 'https://example.org/refused');
  await loadUrlPreview({ urlPreview }, 'https://example.org/allowed');

  expect(urlPreview).toHaveBeenCalledTimes(2);
});
