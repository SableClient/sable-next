// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  onChange: null as ((focused: boolean) => void) | null,
  stop: vi.fn(),
}));

vi.mock('./window-decorations.js', () => ({
  watchWindowFocus: (onChange: (focused: boolean) => void) => {
    native.onChange = onChange;
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
  native.stop.mockReset();
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function track(): { seen: boolean[]; stop: () => void } {
  const seen: boolean[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(windowActivity.active);
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

test('stops listening once nothing reads it', () => {
  const removed = vi.spyOn(window, 'removeEventListener');
  const { seen, stop } = track();
  stop();

  focused = false;
  window.dispatchEvent(new Event('blur'));
  flushSync();

  expect(seen).toEqual([true]);
  expect(removed.mock.calls.map(([type]) => type)).toEqual(['focus', 'blur']);
  expect(windowActivity.active).toBe(false);
});
