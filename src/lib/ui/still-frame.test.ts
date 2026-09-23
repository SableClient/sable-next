// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import { animationsPaused, holdStillFrame } from './still-frame.js';

let focused = true;
let toDataURL: MockInstance<HTMLCanvasElement['toDataURL']>;

beforeEach(() => {
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/png;still');
});

afterEach(() => {
  preferences.pauseAnimationsWhenInactive = false;
  vi.restoreAllMocks();
});

function loadedImage(src: string): HTMLImageElement {
  const image = document.createElement('img');
  image.src = src;
  Object.defineProperty(image, 'complete', { value: true });
  Object.defineProperty(image, 'naturalWidth', { value: 32 });
  Object.defineProperty(image, 'naturalHeight', { value: 32 });
  return image;
}

test('pauses only when the preference is on and the window is inactive', () => {
  focused = false;
  expect(animationsPaused()).toBe(false);

  preferences.pauseAnimationsWhenInactive = true;
  expect(animationsPaused()).toBe(true);

  focused = true;
  expect(animationsPaused()).toBe(false);
});

test('swaps an image to its still frame and back', () => {
  const image = loadedImage('blob:emote');

  holdStillFrame(image, true);
  expect(image.src).toBe('data:image/png;still');

  holdStillFrame(image, true);
  expect(image.src).toBe('data:image/png;still');

  holdStillFrame(image, false);
  expect(image.src).toBe('blob:emote');

  holdStillFrame(image, true);
  expect(image.src).toBe('data:image/png;still');
  expect(toDataURL).toHaveBeenCalledTimes(1);
});

test('leaves an image it cannot read animating', () => {
  toDataURL.mockImplementation(() => {
    throw new DOMException('tainted', 'SecurityError');
  });
  const image = loadedImage('https://example.org/remote.gif');

  holdStillFrame(image, true);

  expect(image.src).toBe('https://example.org/remote.gif');
});

test('waits for an image that has not loaded yet', () => {
  const image = document.createElement('img');
  image.src = 'blob:pending';

  holdStillFrame(image, true);

  expect(image.src).toBe('blob:pending');
});
