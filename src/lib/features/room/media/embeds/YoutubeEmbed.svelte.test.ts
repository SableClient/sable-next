// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import type { UrlPreviewView } from '#src/generated/protocol';

import YoutubeEmbed from './YoutubeEmbed.svelte';

declare const window: Window & { happyDOM: { settings: { disableIframePageLoading: boolean } } };
window.happyDOM.settings.disableIframePageLoading = true;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    await Promise.resolve();
    await tick();
  }
}

test('shows the title and plays the video in place', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(Response.json({ title: 'A video', author_name: 'A channel' }))
  );
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  const { container } = render(YoutubeEmbed, {
    url: 'https://youtu.be/aaaaaaaaaaa?t=42',
    encrypted: false,
  });
  await settle();

  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({ host: 'www.youtube.com', pathname: '/oembed' })
  );
  expect(screen.getByRole('link', { name: 'A channel A video' })).toHaveAttribute(
    'href',
    'https://youtu.be/aaaaaaaaaaa?t=42'
  );
  const play = screen.getByRole('button', { name: 'Play A video' });
  expect(play.querySelector('img')).toHaveAttribute(
    'src',
    'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg'
  );
  expect(container.querySelector('iframe')).not.toBeInTheDocument();

  await user.click(play);

  expect(container.querySelector('iframe')).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa?autoplay=1&start=42'
  );
});

test('falls back to the homeserver preview for a video YouTube will not describe', async () => {
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
  };
  render(YoutubeEmbed, { url: bundled.url, encrypted: false, bundled });
  await settle();

  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
