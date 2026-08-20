import { afterEach, expect, test, vi } from 'vitest';

import { loadMediaUrl } from './media-url.js';

afterEach(() => {
  vi.restoreAllMocks();
});

test('evicts object URLs when cached media exceeds the byte budget', async () => {
  let nextUrl = 0;
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:media-${String(nextUrl++)}`);
  const core = {
    fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(17 * 1024 * 1024))),
  };

  await loadMediaUrl(core, 'mxc://example.org/first', 800, 600);
  await loadMediaUrl(core, 'mxc://example.org/second', 800, 600);

  expect(revoke).toHaveBeenCalledWith('blob:media-0');
});
