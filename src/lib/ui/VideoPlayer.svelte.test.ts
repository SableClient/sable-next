// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
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
