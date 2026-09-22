// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import YoutubeEmbed from './YoutubeEmbed.svelte';

declare const window: Window & { happyDOM: { settings: { disableIframePageLoading: boolean } } };
window.happyDOM.settings.disableIframePageLoading = true;

afterEach(() => {
  document.body.replaceChildren();
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
  const instance = mount(YoutubeEmbed, {
    target: document.body,
    props: { url: 'https://youtu.be/aaaaaaaaaaa?t=42' },
  });
  await settle();

  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({ host: 'www.youtube.com', pathname: '/oembed' })
  );
  expect(document.querySelector('.youtube-title')?.textContent).toBe('A video');
  expect(document.querySelector('.youtube-site')?.textContent).toBe('A channel');
  expect(document.querySelector('.youtube-poster img')?.getAttribute('src')).toBe(
    'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg'
  );
  expect(document.querySelector('iframe')).toBeNull();

  document.querySelector<HTMLButtonElement>('.youtube-poster')?.click();
  flushSync();

  expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
    'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa?autoplay=1&start=42'
  );
  await unmount(instance);
});

test('renders nothing for a video YouTube will not describe', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('Not Found', { status: 404 })))
  );
  const instance = mount(YoutubeEmbed, {
    target: document.body,
    props: { url: 'https://youtu.be/bbbbbbbbbbb' },
  });
  await settle();

  expect(document.querySelector('.youtube-embed')).toBeNull();
  await unmount(instance);
});
