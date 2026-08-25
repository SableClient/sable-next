import { expect, test } from 'vitest';

import { bannerUrl, ROOM_BANNER_EVENT } from './room-banner.svelte.js';

test('reads v1 banner content and ignores anything else', () => {
  expect(ROOM_BANNER_EVENT).toBe('page.codeberg.everypizza.room.banner');
  expect(bannerUrl({ url: 'mxc://example.org/banner' })).toBe('mxc://example.org/banner');
  expect(bannerUrl({ url: '' })).toBeNull();
  expect(bannerUrl({ url: 'https://example.org/banner.png' })).toBeNull();
  expect(bannerUrl({})).toBeNull();
  expect(bannerUrl(null)).toBeNull();
});
