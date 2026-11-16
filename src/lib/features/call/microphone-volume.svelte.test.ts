// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { followMicrophoneVolume } from './microphone-volume.svelte';

const initial = preferences.microphoneVolume;
afterEach(() => {
  preferences.microphoneVolume = initial;
});

test('applies the microphone volume now and on every change until stopped', () => {
  preferences.microphoneVolume = 1.5;
  const applied: number[] = [];
  const stop = followMicrophoneVolume((volume) => applied.push(volume));
  expect(applied.at(-1)).toBe(1.5);

  preferences.microphoneVolume = 0.5;
  flushSync();
  expect(applied.at(-1)).toBe(0.5);

  stop();
  preferences.microphoneVolume = 2;
  flushSync();
  expect(applied.at(-1)).toBe(0.5);
});
