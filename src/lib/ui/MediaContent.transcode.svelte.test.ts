// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
vi.mock('$app/state', () => ({ page: { url: { pathname: '/home' }, params: {}, state: {} } }));
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));

import MediaContent from './MediaContent.svelte';
import { resetVideoStreaming } from './video-stream.svelte.js';
import { resetVideoSupport } from './video-support.js';

/** happy-dom ships no object URLs, so stand one up. */
function installObjectUrl(): void {
  vi.stubGlobal(
    'URL',
    Object.assign(globalThis.URL, {
      createObjectURL: () => 'blob:file',
      revokeObjectURL: () => {},
    })
  );
}

/** '' is the spec's "cannot play", which is what puts a video on this path. */
function canPlayType(answer: string): void {
  vi.spyOn(window.HTMLVideoElement.prototype, 'canPlayType').mockReturnValue(
    answer as CanPlayTypeResult
  );
}

function mountVideo() {
  const props = $state({
    kind: 'video' as const,
    source: 'mxc://example.org/clip',
    mime: 'video/mp4',
    filename: 'clip.mp4',
    width: 1920,
    height: 1080,
  });
  return { instance: mount(MediaContent, { target: document.body, props }), props };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
}

/* Only this suite exercises the re-encoder, so the commands are added here
   rather than to the shared stub, where they would divert every video. */
const streamVideo = vi.fn<(...args: never[]) => Promise<void>>(() => new Promise<never>(() => {}));
const videoStreamMime = vi.fn(() => Promise.resolve('video/webm; codecs="vp9,opus"'));

beforeEach(() => {
  resetVideoSupport();
  resetVideoStreaming();
  installObjectUrl();
  canPlayType('');
  Object.assign(core, { streamVideo, videoStreamMime });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  streamVideo.mockClear();
  videoStreamMime.mockClear();
  delete (core as Record<string, unknown>).streamVideo;
  delete (core as Record<string, unknown>).videoStreamMime;
  document.body.replaceChildren();
});

test('a re-encode does not start until the play button is pressed', async () => {
  const { instance } = mountVideo();
  await settle();

  expect(streamVideo).not.toHaveBeenCalled();
  expect(document.querySelector('.media-play')).not.toBeNull();
  await unmount(instance);
});

test('a re-render does not restart the re-encode', async () => {
  const { instance, props } = mountVideo();
  await settle();

  document.querySelector<HTMLButtonElement>('.media-play')?.click();
  await settle();
  expect(streamVideo).toHaveBeenCalledTimes(1);

  props.mime = 'video/quicktime';
  await settle();
  props.filename = 'clip-renamed.mp4';
  await settle();

  expect(streamVideo).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('a decodable video never reaches the re-encoder', async () => {
  resetVideoSupport();
  canPlayType('probably');

  const { instance } = mountVideo();
  await settle();

  expect(streamVideo).not.toHaveBeenCalled();
  expect(document.querySelector('.media-play')).toBeNull();
  await unmount(instance);
});

test('a build without the native re-encoder leaves the video alone', async () => {
  videoStreamMime.mockRejectedValueOnce(new Error('unknown command'));

  const { instance } = mountVideo();
  await settle();

  expect(streamVideo).not.toHaveBeenCalled();
  expect(document.querySelector('.media-play')).toBeNull();
  await unmount(instance);
});
