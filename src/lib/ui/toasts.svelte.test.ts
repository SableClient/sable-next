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

test('an undo toast runs its close callback when it expires', () => {
  vi.useFakeTimers();
  const toasts = new ToastStore();
  const onUndo = vi.fn();
  const onClose = vi.fn();

  toasts.undoable('Marked General as read', { label: 'Undo', onUndo, onClose });
  vi.advanceTimersByTime(8_000);

  expect(toasts.items).toEqual([]);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onUndo).not.toHaveBeenCalled();
});

test('undo skips the close callback', () => {
  const toasts = new ToastStore();
  const onUndo = vi.fn();
  const onClose = vi.fn();

  toasts.undoable('Marked General as read', { label: 'Undo', onUndo, onClose });
  toasts.items[0]?.action?.run();

  expect(toasts.items).toEqual([]);
  expect(onUndo).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});

test('a held toast outlives its timeout until released', () => {
  vi.useFakeTimers();
  const toasts = new ToastStore();
  const id = toasts.undoable('Marked General as read', { label: 'Undo', onUndo: vi.fn() });

  toasts.hold(id);
  vi.advanceTimersByTime(20_000);
  expect(toasts.items).toHaveLength(1);

  toasts.release(id);
  vi.advanceTimersByTime(8_000);
  expect(toasts.items).toEqual([]);
});
