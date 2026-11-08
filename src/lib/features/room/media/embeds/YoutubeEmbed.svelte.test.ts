// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: () => Promise.resolve({ embeds: { serviceUrl: 'https://embeds.test' } }),
}));

import type { UrlPreviewView } from '#src/generated/protocol';

import { preferences } from '#lib/settings/preferences.svelte.js';

import YoutubeEmbed from './YoutubeEmbed.svelte';

declare const window: Window & { happyDOM: { settings: { disableIframePageLoading: boolean } } };
window.happyDOM.settings.disableIframePageLoading = true;

afterEach(() => {
  preferences.urlPreviews = false;
  preferences.useDearrow = false;
  preferences.dearrowThumbnailFallback = 'youtube_autogen';
  preferences.youtubeThumbnailPosition = 'middle';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    await Promise.resolve();
    await tick();
  }
}

test.each([
  [
    'https://sable.test',
    'aaaaaaaaaaa',
    'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa?autoplay=1&start=42',
  ],
  [
    'tauri://localhost',
    'ddddddddddd',
    'https://embeds.test/_soliditas/embed/youtube?v=ddddddddddd&start=42',
  ],
  [
    'sable-app://app',
    'eeeeeeeeeee',
    'https://embeds.test/_soliditas/embed/youtube?v=eeeeeeeeeee&start=42',
  ],
])('shows the title and plays the video in place on %s', async (origin, id, src) => {
  vi.stubGlobal('location', new URL(origin));
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(Response.json({ title: 'A video', author_name: 'A channel' }))
  );
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  const { container } = render(YoutubeEmbed, {
    url: `https://youtu.be/${id}?t=42`,
    encrypted: false,
  });
  await settle();

  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({ host: 'www.youtube.com', pathname: '/oembed' })
  );
  expect(screen.getByRole('link', { name: 'A channel A video' })).toHaveAttribute(
    'href',
    `https://youtu.be/${id}?t=42`
  );
  const play = screen.getByRole('button', { name: 'Play A video' });
  expect(play.querySelector('img')).toHaveAttribute(
    'src',
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  );
  expect(container.querySelector('iframe')).not.toBeInTheDocument();

  await user.click(play);
  await settle();

  expect(container.querySelector('iframe')).toHaveAttribute('src', src);
});

const dearrowCases = [
  {
    name: 'valid title and thumbnail',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {
      titles: [
        {
          title: 'best title',
          votes: -1,
          locked: true,
        },
      ],
      thumbnails: [
        {
          timestamp: 13.37,
          original: false,
          votes: 0,
          locked: true,
        },
      ],
    },
    videoUrl: 'https://youtu.be/12345678900',
    title: 'best title',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=12345678900&time=13.37&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F12345678900%2Fhq2.jpg',
  },
  {
    name: 'valid title and thumbnail, random fallback still uses youtube',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {
      titles: [
        {
          title: 'best title',
          votes: -1,
          locked: true,
        },
      ],
      thumbnails: [
        {
          timestamp: 13.37,
          original: false,
          votes: 0,
          locked: true,
        },
      ],
    },
    videoUrl: 'https://youtu.be/12345678901',
    title: 'best title',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=12345678901&time=13.37&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F12345678901%2Fhq2.jpg',
  },
  {
    name: 'multiple valid title and thumbnail, picks first valid item',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {
      titles: [
        {
          title: 'wrong title',
          votes: -1,
          locked: false,
        },
        {
          title: 'best title',
          votes: -1,
          locked: true,
        },
        {
          title: 'another title',
          votes: 2137,
          locked: false,
        },
      ],
      thumbnails: [
        {
          timestamp: 21.37,
          original: false,
          votes: -1,
          locked: false,
        },
        {
          timestamp: 13.37,
          original: false,
          votes: 0,
          locked: true,
        },
        {
          timestamp: 67.67,
          original: false,
          votes: 69,
          locked: false,
        },
      ],
    },
    videoUrl: 'https://youtu.be/12345678902',
    title: 'best title',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=12345678902&time=13.37&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F12345678902%2Fhq2.jpg',
  },
  {
    name: 'title with formatter chars gets stripped',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {
      titles: [
        {
          title: '>forced >title',
          votes: 0,
          locked: true,
        },
      ],
      thumbnails: [
        {
          timestamp: 13.37,
          original: false,
          votes: 0,
          locked: true,
        },
      ],
    },
    videoUrl: 'https://youtu.be/12345678903',
    title: 'forced title',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=12345678903&time=13.37&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F12345678903%2Fhq2.jpg',
  },
  {
    name: 'no title but valid thumbnail',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {
      thumbnails: [
        {
          timestamp: 13.37,
          original: false,
          votes: 0,
          locked: true,
        },
      ],
    },
    videoUrl: 'https://youtu.be/12345678904',
    title: 'A video',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=12345678904&time=13.37&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F12345678904%2Fhq2.jpg',
  },
  {
    name: 'no thumbnail but valid title',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {
      titles: [
        {
          title: 'best title',
          votes: 0,
          locked: true,
        },
      ],
    },
    videoUrl: 'https://youtu.be/12345678905',
    title: 'best title',
    thumbnailUrl: 'https://i.ytimg.com/vi/12345678905/hq2.jpg',
  },
  {
    name: 'no valid details, youtube start',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'start';
    },
    overrides: {},
    videoUrl: 'https://youtu.be/12345678906',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/12345678906/hq1.jpg',
  },
  {
    name: 'no valid details, youtube middle',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {},
    videoUrl: 'https://youtu.be/12345678907',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/12345678907/hq2.jpg',
  },
  {
    name: 'no valid details, youtube end',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'youtube_autogen';
      preferences.youtubeThumbnailPosition = 'end';
    },
    overrides: {},
    videoUrl: 'https://youtu.be/12345678908',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/12345678908/hq3.jpg',
  },
  {
    name: 'no valid details, random start, has duration',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'start';
    },
    overrides: {},
    videoUrl: 'https://youtu.be/12345678909',
    title: 'A video',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=12345678909&time=10&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F12345678909%2Fhq1.jpg',
  },
  {
    name: 'no valid details, random middle, has duration',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {},
    videoUrl: 'https://youtu.be/1234567890a',
    title: 'A video',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=1234567890a&time=10&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F1234567890a%2Fhq2.jpg',
  },
  {
    name: 'no valid details, random end, has duration',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'end';
    },
    overrides: {},
    videoUrl: 'https://youtu.be/1234567890b',
    title: 'A video',
    thumbnailUrl:
      'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=1234567890b&time=10&redirectUrl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F1234567890b%2Fhq3.jpg',
  },
  {
    name: 'no valid details, random start, no duration',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'start';
    },
    overrides: {
      videoDuration: null,
    },
    videoUrl: 'https://youtu.be/1234567890c',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/1234567890c/hq1.jpg',
  },
  {
    name: 'no valid details, random start, zero duration',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'start';
    },
    overrides: {
      videoDuration: 0,
    },
    videoUrl: 'https://youtu.be/1234567890g',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/1234567890g/hq1.jpg',
  },
  {
    name: 'no valid details, random middle, no duration',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'middle';
    },
    overrides: {
      videoDuration: null,
    },
    videoUrl: 'https://youtu.be/1234567890d',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/1234567890d/hq2.jpg',
  },
  {
    name: 'no valid details, random end, no duration',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'random';
      preferences.youtubeThumbnailPosition = 'end';
    },
    overrides: {
      videoDuration: null,
    },
    videoUrl: 'https://youtu.be/1234567890e',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/1234567890e/hq3.jpg',
  },
  {
    name: 'no valid details, original',
    setPreferences: () => {
      preferences.dearrowThumbnailFallback = 'original';
    },
    overrides: {
      videoDuration: null,
    },
    videoUrl: 'https://youtu.be/1234567890f',
    title: 'A video',
    thumbnailUrl: 'https://i.ytimg.com/vi/1234567890f/hqdefault.jpg',
  },
];

for (const { name, setPreferences, overrides, videoUrl, title, thumbnailUrl } of dearrowCases) {
  test(`falls back to correct details based on preferences: ${name}`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((url: URL | RequestInfo) => {
      if (!(url instanceof URL)) return Promise.reject(new Error('wut'));
      if (url.host === 'www.youtube.com')
        return Promise.resolve(Response.json({ title: 'A video', author_name: 'A channel' }));
      if (url.host === 'sponsor.ajay.app')
        return Promise.resolve(
          Response.json({
            titles: [
              {
                title: 'wrong title',
                votes: -1,
                locked: false,
              },
            ],
            thumbnails: [
              {
                timestamp: 21.37,
                original: false,
                votes: -1,
                locked: false,
              },
            ],
            randomTime: 0.5,
            videoDuration: 20,
            ...overrides,
          })
        );
      return Promise.reject(new Error('wut'));
    });
    vi.stubGlobal('fetch', fetch);
    preferences.useDearrow = true;
    setPreferences();
    render(YoutubeEmbed, {
      url: videoUrl,
      encrypted: false,
    });
    await settle();

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'www.youtube.com', pathname: '/oembed' })
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'sponsor.ajay.app', pathname: '/api/branding' })
    );
    expect(screen.getByRole('link', { name: `A channel ${title}` })).toHaveAttribute(
      'href',
      videoUrl
    );
    const play = screen.getByRole('button', { name: `Play ${title}` });
    expect(play.querySelector('img')).toHaveAttribute('src', thumbnailUrl);
  });
}

test('falls back to the homeserver preview for a video YouTube will not describe', async () => {
  preferences.urlPreviews = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('Not Found', { status: 404 })))
  );
  const bundled: UrlPreviewView = {
    url: 'https://youtu.be/bbbbbbbbbbb',
    title: 'Unavailable video',
    description: null,
    site_name: 'YouTube',
    image: null,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: null,
  };
  render(YoutubeEmbed, { url: bundled.url, encrypted: false, bundled });
  await settle();

  expect(screen.getByRole('link', { name: 'Unavailable video' }).parentElement).toHaveClass(
    'youtube-preview'
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('shows no homeserver preview while YouTube has not answered', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
  const bundled: UrlPreviewView = {
    url: 'https://youtu.be/ccccccccccc',
    title: 'Pending video',
    description: null,
    site_name: 'YouTube',
    image: null,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: null,
  };
  render(YoutubeEmbed, { url: bundled.url, encrypted: false, bundled });
  await settle();

  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
