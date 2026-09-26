// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import AudioTrack from './AudioTrack.svelte';

test('shows the track title, then artist and album', () => {
  const { container } = render(AudioTrack, {
    metadata: { title: 'Moonwalker', artist: 'Jake Chudnow', album: 'The Moon', cover_art: null },
    fallbackTitle: 'Moonwalker.flac',
  });

  expect(screen.getByText('Moonwalker')).toHaveClass('audio-track-title');
  expect(screen.getByText('Jake Chudnow · The Moon')).toHaveClass('audio-track-byline');
  expect(container.querySelector('.audio-track-cover.empty svg')).toBeInTheDocument();
});

test('falls back to the file name when the track has no title', () => {
  render(AudioTrack, {
    metadata: { title: null, artist: 'Jake Chudnow', album: null, cover_art: null },
    fallbackTitle: 'Moonwalker.flac',
  });

  expect(screen.getByText('Moonwalker.flac')).toHaveClass('audio-track-title');
  expect(screen.getByText('Jake Chudnow')).toHaveClass('audio-track-byline');
});
