import { describe, expect, it } from 'vitest';

import { parseTiktokLink, tiktokPlayerUrl } from './tiktok';

describe('parseTiktokLink', () => {
  it.each([
    'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'https://tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1&sender_device=pc',
    'https://m.tiktok.com/@scout2015/video/6718335390845095173',
    'https://www.tiktok.com/@scout2015/photo/6718335390845095173',
  ])('reads the post id from %s', (href) => {
    expect(parseTiktokLink(href)).toEqual({ id: '6718335390845095173', author: '@scout2015' });
  });

  it.each([
    'https://www.tiktok.com/',
    'https://www.tiktok.com/@scout2015',
    'https://www.tiktok.com/@scout2015/video/abc',
    'https://www.tiktok.com/@scout2015/video/6718335390845095173/extra',
    'https://www.tiktok.com/@scout2015/live/6718335390845095173',
    'https://vm.tiktok.com/ZMabc123/',
    'https://evil.example/@scout2015/video/6718335390845095173',
    'https://nottiktok.com/@scout2015/video/6718335390845095173',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (href) => {
    expect(parseTiktokLink(href)).toBeNull();
  });
});

describe('tiktokPlayerUrl', () => {
  it('points at the official player and autoplays', () => {
    expect(tiktokPlayerUrl({ id: '6718335390845095173', author: null })).toBe(
      'https://www.tiktok.com/player/v1/6718335390845095173?autoplay=1'
    );
  });
});
