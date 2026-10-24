// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  onChange: null as ((focused: boolean) => void) | null,
  initialFocus: null as boolean | null,
  stop: vi.fn(),
}));

vi.mock('./window-decorations.js', () => ({
  watchWindowFocus: (onChange: (focused: boolean) => void) => {
    native.onChange = onChange;
    if (native.initialFocus !== null) onChange(native.initialFocus);
    return Promise.resolve(native.stop);
  },
}));

import { windowActivity } from './window-activity.js';

let focused = true;
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  focused = true;
  visibility = 'visible';
  native.onChange = null;
  native.initialFocus = null;
  native.stop.mockReset();
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function track(activity: 'active' | 'visible' = 'active'): { seen: boolean[]; stop: () => void } {
  const seen: boolean[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(windowActivity[activity]);
    });
  });
  flushSync();
  return { seen, stop };
}

test('goes inactive on blur and active again on focus', () => {
  const { seen, stop } = track();

  focused = false;
  window.dispatchEvent(new Event('blur'));
  flushSync();
  focused = true;
  window.dispatchEvent(new Event('focus'));
  flushSync();

  expect(seen).toEqual([true, false, true]);
  stop();
});

test('goes inactive while the document is hidden', () => {
  const { seen, stop } = track();

  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  flushSync();
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  flushSync();

  expect(seen).toEqual([true, false, true]);
  stop();
});

test('goes invisible when a PWA page is hidden or frozen', () => {
  const { seen, stop } = track('visible');

  window.dispatchEvent(new Event('pagehide'));
  flushSync();
  window.dispatchEvent(new Event('pageshow'));
  flushSync();
  document.dispatchEvent(new Event('freeze'));
  flushSync();
  document.dispatchEvent(new Event('resume'));
  flushSync();

  expect(seen).toEqual([true, false, true, false, true]);
  stop();
});

test('trusts the native window focus over the document', async () => {
  const { seen, stop } = track();
  await Promise.resolve();

  native.onChange?.(false);
  flushSync();

  expect(seen).toEqual([true, false]);
  stop();
  await Promise.resolve();
  expect(native.stop).toHaveBeenCalled();
});

test('starts inactive when the native window is already minimized', async () => {
  native.initialFocus = false;
  const { seen, stop } = track();
  await Promise.resolve();

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((active) => !active)).toBe(true);
  native.onChange?.(true);
  flushSync();
  expect(seen.at(-1)).toBe(true);
  stop();
});

test('stops listening once nothing reads it', () => {
  const removed = vi.spyOn(window, 'removeEventListener');
  const { seen, stop } = track();
  stop();

  focused = false;
  window.dispatchEvent(new Event('blur'));
  flushSync();

  expect(seen).toEqual([true]);
  expect(removed.mock.calls.map(([type]) => type)).toEqual([
    'focus',
    'blur',
    'pagehide',
    'pageshow',
  ]);
  expect(windowActivity.active).toBe(false);
});

test('goes idle after five minutes without input and wakes on input', () => {
  vi.useFakeTimers();
  const seen: boolean[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(windowActivity.idle);
    });
  });
  flushSync();

  vi.advanceTimersByTime(4 * 60_000);
  window.dispatchEvent(new Event('keydown'));
  vi.advanceTimersByTime(4 * 60_000);
  flushSync();
  expect(seen).toEqual([false]);

  vi.advanceTimersByTime(60_000);
  flushSync();
  window.dispatchEvent(new Event('pointermove'));
  flushSync();

  expect(seen).toEqual([false, true, false]);
  stop();
  vi.useRealTimers();
});

test('tells a reader when the grace after a long absence ends', () => {
  vi.useFakeTimers();
  const now = vi.spyOn(performance, 'now');
  now.mockReturnValue(1_000_000);
  const seen: boolean[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(windowActivity.recentlyResumed);
    });
  });
  flushSync();

  focused = false;
  window.dispatchEvent(new Event('blur'));
  flushSync();
  now.mockReturnValue(1_040_000);
  focused = true;
  window.dispatchEvent(new Event('focus'));
  flushSync();
  now.mockReturnValue(1_049_000);
  vi.advanceTimersByTime(8_000);
  flushSync();

  expect(seen.at(-1)).toBe(false);
  expect(seen).toContain(true);
  stop();
  vi.useRealTimers();
});
