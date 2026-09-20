import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { canPlayVideo, resetVideoSupport } from './video-support.js';

beforeEach(() => {
  resetVideoSupport();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubCanPlayType(answer: string): ReturnType<typeof vi.fn> {
  const canPlayType = vi.fn(() => answer);
  vi.spyOn(document, 'createElement').mockReturnValue({
    canPlayType,
  } as unknown as HTMLElement);
  return canPlayType;
}

test('reports mp4 unplayable when the engine carries no H.264 decoder', () => {
  stubCanPlayType('');
  expect(canPlayVideo('video/mp4')).toBe(false);
});

test('reports mp4 playable on a maybe, which is the spec’s weakest yes', () => {
  stubCanPlayType('maybe');
  expect(canPlayVideo('video/mp4')).toBe(true);
});

test('probes the codec string, not the bare container', () => {
  const canPlayType = stubCanPlayType('');
  canPlayVideo('video/mp4');
  expect(canPlayType).toHaveBeenCalledWith('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
});

test('ignores mime parameters when choosing a probe', () => {
  const canPlayType = stubCanPlayType('');
  expect(canPlayVideo('video/mp4; codecs="avc1.64001E"')).toBe(false);
  expect(canPlayType).toHaveBeenCalledOnce();
});

test('treats an unprobed type as playable without asking the engine', () => {
  const canPlayType = stubCanPlayType('');
  expect(canPlayVideo('video/webm')).toBe(true);
  expect(canPlayType).not.toHaveBeenCalled();
});

test('treats a missing mime as playable', () => {
  const canPlayType = stubCanPlayType('');
  expect(canPlayVideo(null)).toBe(true);
  expect(canPlayType).not.toHaveBeenCalled();
});

test('asks the engine once per type', () => {
  const canPlayType = stubCanPlayType('');
  canPlayVideo('video/mp4');
  canPlayVideo('video/mp4');
  expect(canPlayType).toHaveBeenCalledOnce();
});
