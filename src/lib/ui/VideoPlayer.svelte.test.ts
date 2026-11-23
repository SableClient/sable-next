// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';

import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { flushed } from '#lib/ui/flushed.js';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import VideoPlayer from './VideoPlayer.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';

afterEach(() => {
  core.fetchMedia.mockReset();
  preferences.pauseAnimationsWhenInactive = false;
  vi.restoreAllMocks();
});

const gif = {
  gif: true,
  autoplay: true,
  looping: true,
  hide_controls: true,
  no_audio: true,
};

async function mountGif(source: string): Promise<HTMLVideoElement> {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  render(VideoPlayer, { source, mime: 'video/mp4', filename: 'cat.mp4', playback: gif });
  await vi.waitFor(() => {
    if (!document.querySelector('video')) throw new Error('no video yet');
  });
  return document.querySelector('video') as HTMLVideoElement;
}

test('a bridged GIF pauses while the window is inactive and resumes after', async () => {
  preferences.pauseAnimationsWhenInactive = true;
  let focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const video = await mountGif('mxc://example.org/gif-inactive');
  const pause = vi.spyOn(video, 'pause');
  const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
  vi.spyOn(video, 'paused', 'get').mockReturnValue(false);

  focused = false;
  window.dispatchEvent(new Event('blur'));
  await flushed();
  expect(pause).toHaveBeenCalledOnce();

  focused = true;
  window.dispatchEvent(new Event('focus'));
  await flushed();
  expect(play).toHaveBeenCalledOnce();
});

test('a GIF that arrives while the window is inactive pauses once it starts', async () => {
  preferences.pauseAnimationsWhenInactive = true;
  let focused = false;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const video = await mountGif('mxc://example.org/gif-arrives-inactive');
  await flushed();
  const pause = vi.spyOn(video, 'pause');
  const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);

  vi.spyOn(video, 'paused', 'get').mockReturnValue(false);
  video.dispatchEvent(new Event('play'));
  await flushed();
  expect(pause).toHaveBeenCalledOnce();

  focused = true;
  window.dispatchEvent(new Event('focus'));
  await flushed();
  expect(play).toHaveBeenCalledOnce();
});

test('a GIF the user paused stays paused when the window comes back', async () => {
  preferences.pauseAnimationsWhenInactive = true;
  let focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const video = await mountGif('mxc://example.org/gif-user-paused');
  const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
  vi.spyOn(video, 'paused', 'get').mockReturnValue(true);

  focused = false;
  window.dispatchEvent(new Event('blur'));
  await flushed();
  focused = true;
  window.dispatchEvent(new Event('focus'));
  await flushed();

  expect(play).not.toHaveBeenCalled();
});

test('a video waiting to be played shows how much it will download', () => {
  const { container } = render(VideoPlayer, {
    source: 'mxc://example.org/clip',
    mime: 'video/mp4',
    filename: 'clip.mp4',
    size: 5_000_000,
  });

  expect(container.querySelector('.media-play')).not.toBeNull();
  expect(container.querySelector('.media-image-size')?.textContent).toBe('5.0 MB');
});

test.each([
  { name: 'hevc.mov', canPlay: '', plays: false },
  { name: 'hevc.mov', canPlay: 'probably', plays: true },
  { name: 'h264.mp4', canPlay: '', plays: true },
])('$name with canPlayType "$canPlay" plays: $plays', async ({ name, canPlay, plays }) => {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(canPlay as CanPlayTypeResult);
  const bytes = new Uint8Array(readFileSync(`src/lib/features/composer/fixtures/${name}`));
  core.fetchMedia.mockResolvedValue(bytes);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
  render(VideoPlayer, {
    source: `mxc://example.org/${name}-${canPlay}`,
    mime: 'video/mp4',
    filename: name,
    playback: gif,
  });

  await vi.waitFor(() => {
    if (!document.querySelector('video, .media-unsupported')) throw new Error('not checked yet');
  });
  expect(document.querySelector('video') !== null).toBe(plays);
  expect(screen.queryByText(/can't be played on this device/) !== null).toBe(!plays);
});

test('a bridged GIF without controls opens the media viewer when clicked', async () => {
  const onOpen = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  render(VideoPlayer, {
    source: 'mxc://example.org/gif-open',
    mime: 'video/mp4',
    filename: 'cat.mp4',
    playback: gif,
    onOpen,
  });
  await vi.waitFor(() => {
    if (!document.querySelector('video')) throw new Error('no video yet');
  });

  await fireEvent.click(screen.getByRole('button', { name: 'Open cat.mp4' }));

  expect(onOpen).toHaveBeenCalledOnce();
});

test('a video with native controls leaves opening to the fullscreen control', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  render(VideoPlayer, {
    source: 'mxc://example.org/clip-controls',
    mime: 'video/mp4',
    filename: 'clip.mp4',
    playback: { ...gif, hide_controls: false },
    onOpen: vi.fn(),
  });
  await vi.waitFor(() => {
    if (!document.querySelector('video')) throw new Error('no video yet');
  });

  expect(screen.queryByRole('button', { name: 'Open clip.mp4' })).toBeNull();
});
