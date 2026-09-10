import { hapticFeedback } from '#lib/platform/haptics.js';
import { beforeEach, expect, test, vi } from 'vitest';

import { LongPress } from './long-press.svelte.js';

vi.mock('#lib/platform/haptics.js', () => ({ hapticFeedback: vi.fn() }));

beforeEach(() => vi.mocked(hapticFeedback).mockClear());

function pointer(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerType: 'touch',
    clientX: 0,
    clientY: 0,
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as PointerEvent;
}

test('a held press fires once the delay elapses', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer());
  expect(onPress).not.toHaveBeenCalled();
  expect(hapticFeedback).not.toHaveBeenCalled();

  vi.advanceTimersByTime(450);

  expect(onPress).toHaveBeenCalledOnce();
  expect(hapticFeedback).toHaveBeenCalledExactlyOnceWith('medium');
  expect(press.fired).toBe(true);
  vi.useRealTimers();
});

test('a mouse press never fires, but still reports the pointer kind', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer({ pointerType: 'mouse' }));
  vi.advanceTimersByTime(1000);

  expect(onPress).not.toHaveBeenCalled();
  expect(hapticFeedback).not.toHaveBeenCalled();
  expect(press.touch).toBe(false);
  vi.useRealTimers();
});

test('sliding past the slop cancels the press', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer());
  press.move(pointer({ clientX: 40 }));
  vi.advanceTimersByTime(1000);

  expect(onPress).not.toHaveBeenCalled();
  expect(hapticFeedback).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('staying within the slop keeps the press alive', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer());
  press.move(pointer({ clientX: 4 }));
  vi.advanceTimersByTime(450);

  expect(onPress).toHaveBeenCalledOnce();
  expect(hapticFeedback).toHaveBeenCalledExactlyOnceWith('medium');
  vi.useRealTimers();
});

test('a disabled press never arms', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ enabled: () => false, onPress });

  press.start(pointer());
  vi.advanceTimersByTime(1000);

  expect(onPress).not.toHaveBeenCalled();
  expect(hapticFeedback).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('cancelling drops a timer that a virtualised row would otherwise leave running', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer());
  press.cancel();
  vi.advanceTimersByTime(1000);

  expect(onPress).not.toHaveBeenCalled();
  expect(hapticFeedback).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('stopPropagation is opt-in', () => {
  const quietStop = vi.fn();
  new LongPress({ onPress: vi.fn() }).start(pointer({ stopPropagation: quietStop }));
  expect(quietStop).not.toHaveBeenCalled();

  const loudStop = vi.fn();
  new LongPress({ stopPropagation: true, onPress: vi.fn() }).start(
    pointer({ stopPropagation: loudStop })
  );
  expect(loudStop).toHaveBeenCalled();
});

test('the trailing click a fired press produces is swallowed once', () => {
  vi.useFakeTimers();
  const press = new LongPress({ onPress: vi.fn() });
  const onSheetItem = vi.fn();
  const item = document.createElement('button');
  item.addEventListener('click', onSheetItem);
  document.body.append(item);

  press.start(pointer());
  vi.advanceTimersByTime(450);
  press.end(pointer());
  item.click();

  expect(onSheetItem).not.toHaveBeenCalled();

  item.click();
  expect(onSheetItem).toHaveBeenCalledOnce();

  item.remove();
  vi.useRealTimers();
});
