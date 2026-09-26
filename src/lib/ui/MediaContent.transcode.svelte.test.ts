// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
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
  return { instance: render(MediaContent, { props }), props };
}

const playButton = () => screen.queryByRole('button', { name: /^Play / });

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
});

test('a re-encode does not start until the play button is pressed', async () => {
  mountVideo();
  await settle();

  expect(streamVideo).not.toHaveBeenCalled();
  expect(playButton()).toBeInTheDocument();
});

test('a re-render does not restart the re-encode', async () => {
  const { props } = mountVideo();
  await settle();

  await userEvent.click(screen.getByRole('button', { name: /^Play / }));
  await settle();
  expect(streamVideo).toHaveBeenCalledTimes(1);

  props.mime = 'video/quicktime';
  await settle();
  props.filename = 'clip-renamed.mp4';
  await settle();

  expect(streamVideo).toHaveBeenCalledTimes(1);
});

test('a decodable video never reaches the re-encoder', async () => {
  resetVideoSupport();
  canPlayType('probably');

  mountVideo();
  await settle();

  await userEvent.click(screen.getByRole('button', { name: /^Play / }));
  await settle();

  expect(streamVideo).not.toHaveBeenCalled();
  expect(playButton()).not.toBeInTheDocument();
});

function streamOnce(): void {
  streamVideo.mockImplementationOnce(((
    _source: string,
    _id: number,
    onChunk: (chunk: Uint8Array) => void
  ) => {
    onChunk(new Uint8Array([1]));
    return Promise.resolve();
  }) as never);
}

function trackObjectUrls() {
  let next = 0;
  const revoked: string[] = [];
  vi.stubGlobal(
    'URL',
    Object.assign(globalThis.URL, {
      createObjectURL: () => `blob:stream-${String(next++)}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    })
  );
  return revoked;
}

test('the re-encoded stream is revoked when the tile unmounts', async () => {
  const revoked = trackObjectUrls();
  streamOnce();
  const { instance } = mountVideo();
  await settle();

  await userEvent.click(screen.getByRole('button', { name: /^Play / }));
  await settle();
  expect(revoked).toEqual([]);

  instance.unmount();

  expect(revoked).toEqual(['blob:stream-0']);
});

test('the re-encoded stream is revoked when the tile is recycled for another video', async () => {
  const revoked = trackObjectUrls();
  streamOnce();
  const { props } = mountVideo();
  await settle();

  await userEvent.click(screen.getByRole('button', { name: /^Play / }));
  await settle();

  props.source = 'mxc://example.org/other';
  await settle();

  expect(revoked).toEqual(['blob:stream-0']);
});

test('a re-encode that lands after the tile moved on is revoked at once', async () => {
  const revoked = trackObjectUrls();
  let finish = (): void => {};
  streamVideo.mockImplementationOnce(((
    _source: string,
    _id: number,
    onChunk: (chunk: Uint8Array) => void
  ) => {
    onChunk(new Uint8Array([1]));
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  }) as never);
  const { props } = mountVideo();
  await settle();

  await userEvent.click(screen.getByRole('button', { name: /^Play / }));
  await settle();
  props.source = 'mxc://example.org/other';
  await settle();
  finish();
  await settle();

  expect(revoked).toEqual(['blob:stream-0']);
});

test('a re-encode that lands after the tile unmounted is revoked at once', async () => {
  const revoked = trackObjectUrls();
  let finish = (): void => {};
  streamVideo.mockImplementationOnce(((
    _source: string,
    _id: number,
    onChunk: (chunk: Uint8Array) => void
  ) => {
    onChunk(new Uint8Array([1]));
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  }) as never);
  const { instance } = mountVideo();
  await settle();

  await userEvent.click(screen.getByRole('button', { name: /^Play / }));
  await settle();
  instance.unmount();
  finish();
  await settle();

  expect(revoked).toEqual(['blob:stream-0']);
});

test('a build without the native re-encoder leaves the video alone', async () => {
  videoStreamMime.mockRejectedValueOnce(new Error('unknown command'));

  mountVideo();
  await settle();

  await userEvent.click(screen.getByRole('button', { name: /^Play / }));
  await settle();

  expect(streamVideo).not.toHaveBeenCalled();
  expect(playButton()).not.toBeInTheDocument();
});
