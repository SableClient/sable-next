import { expect, test } from 'vitest';

import {
  gifFilename,
  gifProvider,
  gifProviders,
  gifSearchAvailable,
  isAllowedGifMediaUrl,
  proxiedGif,
  type GifResult,
  type GifsConfig,
} from './providers';

const config: GifsConfig = {
  provider: 'tenor',
  proxyUrl: 'gifs.example',
  klipyApiKey: 'klipy-key',
  tenorApiKey: 'tenor-key',
  giphyApiKey: null,
};

const gif = (overrides: Partial<GifResult> = {}): GifResult => ({
  id: 'abc',
  title: 'a cat',
  mediaUrl: 'https://media.tenor.com/abc123/cat.gif',
  previewUrl: 'https://media.tenor.com/abc123/cat-tiny.gif',
  width: 320,
  height: 240,
  size: 1000,
  mimetype: 'image/gif',
  ...overrides,
});

test('tenor reports the largest rendition that fits, and the small one as preview', () => {
  const results = gifProviders.tenor.parse({
    results: [
      {
        id: 'abc',
        content_description: 'a cat',
        media_formats: {
          gif: { url: 'https://media.tenor.com/abc/full.gif', dims: [800, 600], size: 9_000_000 },
          mediumgif: {
            url: 'https://media.tenor.com/abc/medium.gif',
            dims: [400, 300],
            size: 500_000,
          },
          tinygif: { url: 'https://media.tenor.com/abc/tiny.gif', dims: [200, 150], size: 40_000 },
        },
      },
    ],
  });

  expect(results).toEqual([
    {
      id: 'abc',
      title: 'a cat',
      mediaUrl: 'https://media.tenor.com/abc/medium.gif',
      previewUrl: 'https://media.tenor.com/abc/tiny.gif',
      width: 400,
      height: 300,
      size: 500_000,
      mimetype: 'image/gif',
    },
  ]);
});

test('a payload in the wrong shape yields no results rather than throwing', () => {
  for (const provider of Object.values(gifProviders)) {
    expect(provider.parse(null)).toEqual([]);
    expect(provider.parse({ results: 'no' })).toEqual([]);
    expect(provider.parse({ data: [42, null] })).toEqual([]);
  }
});

test('klipy keeps only the gif encoding of each size', () => {
  const results = gifProviders.klipy.parse({
    data: {
      data: [
        {
          id: 7,
          title: 'dog',
          file: {
            xs: { webp: { url: 'https://static.klipy.com/ii/xs.webp' } },
            hd: { gif: { url: 'https://static.klipy.com/ii/hd.gif', width: 500, height: 500 } },
          },
        },
      ],
    },
  });

  expect(results[0].mediaUrl).toBe('https://static.klipy.com/ii/hd.gif');
  expect(results[0].previewUrl).toBe('https://static.klipy.com/ii/hd.gif');
  expect(results[0].id).toBe('7');
});

test('only a provider CDN is an allowed media url', () => {
  expect(isAllowedGifMediaUrl('https://media.tenor.com/abc/cat.gif')).toBe(true);
  expect(isAllowedGifMediaUrl('https://static.klipy.com/ii/cat.gif')).toBe(true);
  expect(isAllowedGifMediaUrl('https://i.giphy.com/abc/cat.gif')).toBe(true);

  expect(isAllowedGifMediaUrl('http://media.tenor.com/abc/cat.gif')).toBe(false);
  expect(isAllowedGifMediaUrl('https://evil.example/media.tenor.com/cat.gif')).toBe(false);
  expect(isAllowedGifMediaUrl('https://media.tenor.com.evil.example/cat.gif')).toBe(false);
  expect(isAllowedGifMediaUrl('https://user:pw@media.tenor.com/abc/cat.gif')).toBe(false);
  expect(isAllowedGifMediaUrl('https://static.klipy.com/other/cat.gif')).toBe(false);
  expect(isAllowedGifMediaUrl('not a url')).toBe(false);
});

test('the proxy mxc names the provider and its media, base64url encoded', () => {
  expect(proxiedGif(gif(), 'gifs.example')).toEqual({
    mxcUrl: 'mxc://gifs.example/tenor_YWJjMTIz',
    mimetype: 'image/gif',
  });
});

test('giphy is proxied by its result id, and the proxy serves webp', () => {
  const proxied = proxiedGif(
    gif({ id: 'giphy-id', mediaUrl: 'https://i.giphy.com/media/xyz/cat.gif' }),
    'gifs.example'
  );

  expect(proxied?.mimetype).toBe('image/webp');
  expect(proxied?.mxcUrl.startsWith('mxc://gifs.example/giphy_')).toBe(true);
});

test('a result off any provider CDN, or no proxy at all, cannot be proxied', () => {
  expect(
    proxiedGif(gif({ mediaUrl: 'https://evil.example/cat.gif' }), 'gifs.example')
  ).toBeUndefined();
  expect(proxiedGif(gif({ mediaUrl: 'not a url' }), 'gifs.example')).toBeUndefined();
  expect(proxiedGif(gif(), null)).toBeUndefined();
  expect(proxiedGif(gif(), '   ')).toBeUndefined();
});

test('an override to a provider with no key falls back to the configured one', () => {
  expect(gifProvider(config, 'klipy').id).toBe('klipy');
  expect(gifProvider(config, 'giphy').id).toBe('tenor');
  expect(gifProvider(config).id).toBe('tenor');
  expect(gifProvider({ ...config, provider: null }).id).toBe('tenor');
});

test('tenor searches under the one client_key Google still accepts', () => {
  const url = new URL(gifProviders.tenor.searchUrl('a-key', 'a cat'));

  expect(url.searchParams.get('client_key')).toBe('tenor_web');
  expect(url.searchParams.get('key')).toBe('a-key');
  expect(url.searchParams.get('q')).toBe('a cat');
});

test('search needs both a key and a proxy', () => {
  expect(gifSearchAvailable(config)).toBe(true);
  expect(gifSearchAvailable({ ...config, proxyUrl: null })).toBe(false);
  expect(gifSearchAvailable({ ...config, tenorApiKey: null })).toBe(false);
});

test('a filename gets the extension the proxy will actually serve', () => {
  expect(gifFilename('a cat', 'image/gif')).toBe('a cat.gif');
  expect(gifFilename('a cat.gif', 'image/gif')).toBe('a cat.gif');
  expect(gifFilename('a cat', 'image/webp')).toBe('a cat.webp');
});
