// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import AudioTrack from './AudioTrack.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('shows the track title, then artist and album', async () => {
  const instance = mount(AudioTrack, {
    target: document.body,
    props: {
      metadata: { title: 'Moonwalker', artist: 'Jake Chudnow', album: 'The Moon', cover_art: null },
      fallbackTitle: 'Moonwalker.flac',
    },
  });
  await tick();

  expect(document.querySelector('.audio-track-title')?.textContent).toBe('Moonwalker');
  expect(document.querySelector('.audio-track-byline')?.textContent).toBe(
    'Jake Chudnow · The Moon'
  );
  expect(document.querySelector('.audio-track-cover.empty svg')).not.toBeNull();
  await unmount(instance);
});

test('falls back to the file name when the track has no title', async () => {
  const instance = mount(AudioTrack, {
    target: document.body,
    props: {
      metadata: { title: null, artist: 'Jake Chudnow', album: null, cover_art: null },
      fallbackTitle: 'Moonwalker.flac',
    },
  });
  await tick();

  expect(document.querySelector('.audio-track-title')?.textContent).toBe('Moonwalker.flac');
  expect(document.querySelector('.audio-track-byline')?.textContent).toBe('Jake Chudnow');
  await unmount(instance);
});
