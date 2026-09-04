import { afterEach, expect, test, vi } from 'vitest';

import { ToastStore } from './toasts.svelte.js';

afterEach(() => {
  vi.useRealTimers();
});

test('adds an error toast and automatically dismisses it', () => {
  vi.useFakeTimers();
  const toasts = new ToastStore();

  toasts.error('Could not copy link.');

  expect(toasts.items).toHaveLength(1);
  expect(toasts.items[0]?.message).toBe('Could not copy link.');

  vi.advanceTimersByTime(5_000);
  expect(toasts.items).toEqual([]);
});

test('dismisses a toast before its timeout', () => {
  const toasts = new ToastStore();
  const id = toasts.error('Could not update the room.');

  toasts.dismiss(id);

  expect(toasts.items).toEqual([]);
});
