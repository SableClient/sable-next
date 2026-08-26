import { expect, test, vi } from 'vitest';

import { LongPress } from './long-press.svelte.js';

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

  vi.advanceTimersByTime(450);

  expect(onPress).toHaveBeenCalledOnce();
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
  vi.useRealTimers();
});

test('a disabled press never arms', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ enabled: () => false, onPress });

  press.start(pointer());
  vi.advanceTimersByTime(1000);

  expect(onPress).not.toHaveBeenCalled();
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
