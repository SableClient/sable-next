import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isTiktokShortLink,
  parseTiktokLink,
  resolveTiktokShortLink,
  tiktokPlayerUrl,
} from './tiktok';

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

describe('isTiktokShortLink', () => {
  it.each([
    'https://vm.tiktok.com/ZN8BdN8wW/',
    'https://vt.tiktok.com/ZN8BdN8wW',
    'https://www.tiktok.com/t/ZN8BdN8wW/',
  ])('accepts %s', (href) => {
    expect(isTiktokShortLink(href)).toBe(true);
  });

  it.each([
    'https://vm.tiktok.com/',
    'https://vm.tiktok.com/ZN8BdN8wW/extra',
    'https://www.tiktok.com/t/',
    'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'https://vm.tiktok.com.evil.example/ZN8BdN8wW/',
    'https://evil.example/t/ZN8BdN8wW/',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (href) => {
    expect(isTiktokShortLink(href)).toBe(false);
  });
});

describe('resolveTiktokShortLink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(body: unknown, ok = true): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads the post id and author from oEmbed', async () => {
    const fetchMock = answer({
      html: '<blockquote data-video-id="7692330011847576865"></blockquote>',
      author_url: 'https://www.tiktok.com/@rblxcatinho',
    });

    await expect(resolveTiktokShortLink('https://vm.tiktok.com/ZNaaaa/')).resolves.toEqual({
      id: '7692330011847576865',
      author: '@rblxcatinho',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://www.tiktok.com/oembed?url=https%3A%2F%2Fvm.tiktok.com%2FZNaaaa%2F'
    );
  });

  it('asks once per link', async () => {
    const fetchMock = answer({ html: 'data-video-id="1234567890"', author_url: '' });

    await resolveTiktokShortLink('https://vm.tiktok.com/ZNbbbb/');
    await resolveTiktokShortLink('https://vm.tiktok.com/ZNbbbb/');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up when oEmbed refuses the link', async () => {
    answer({}, false);
    await expect(resolveTiktokShortLink('https://vm.tiktok.com/ZNcccc/')).resolves.toBeNull();
  });

  it('gives up when the answer has no post id', async () => {
    answer({ html: '<blockquote></blockquote>' });
    await expect(resolveTiktokShortLink('https://vm.tiktok.com/ZNdddd/')).resolves.toBeNull();
  });
});
