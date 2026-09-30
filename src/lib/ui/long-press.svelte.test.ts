import { hapticFeedback } from '#lib/platform/haptics.js';
import { guardTouchClicks } from '#lib/ui/trailing-click.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LONG_PRESS_MS, LongPress, longPress, mouseContextMenu } from './long-press.svelte.js';

vi.mock('#lib/platform/haptics.js', () => ({ hapticFeedback: vi.fn() }));

beforeEach(() => vi.mocked(hapticFeedback).mockClear());
afterEach(() => vi.useRealTimers());

function pointer(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerType: 'touch',
    isPrimary: true,
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

  vi.advanceTimersByTime(LONG_PRESS_MS);

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

test('a mouse press resets the previous touch hold', () => {
  vi.useFakeTimers();
  const press = new LongPress({ onPress: vi.fn() });

  press.start(pointer());
  vi.advanceTimersByTime(LONG_PRESS_MS);
  expect(press.fired).toBe(true);
  press.start(pointer({ pointerType: 'mouse' }));

  expect(press.fired).toBe(false);
  expect(press.touch).toBe(false);
});

test('secondary pointers do not start a hold', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer({ isPrimary: false }));
  vi.advanceTimersByTime(LONG_PRESS_MS);

  expect(onPress).not.toHaveBeenCalled();
});

test('secondary pointers do not interrupt the primary hold', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer({ isPrimary: true }));
  vi.advanceTimersByTime(100);
  press.start(pointer({ isPrimary: false }));
  press.move(pointer({ isPrimary: false, clientX: 40 }));
  press.lift(pointer({ isPrimary: false }));
  press.cancelled(pointer({ isPrimary: false }));
  vi.advanceTimersByTime(LONG_PRESS_MS - 100);

  expect(onPress).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(LONG_PRESS_MS);
  expect(onPress).toHaveBeenCalledOnce();
});

test('restarting a hold cancels the previous timer', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const press = new LongPress({ onPress });

  press.start(pointer());
  vi.advanceTimersByTime(100);
  press.start(pointer());
  press.lift(pointer());
  vi.advanceTimersByTime(LONG_PRESS_MS);

  expect(onPress).not.toHaveBeenCalled();
});

test('a hold disabled before the delay elapses does not fire', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  let enabled = true;
  const press = new LongPress({ enabled: () => enabled, onPress });

  press.start(pointer());
  enabled = false;
  vi.advanceTimersByTime(LONG_PRESS_MS);

  expect(onPress).not.toHaveBeenCalled();
  expect(press.pressing).toBe(false);
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
  vi.advanceTimersByTime(LONG_PRESS_MS);

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

test('the clicks a fired press produces are swallowed until the lift settles', () => {
  vi.useFakeTimers();
  const press = new LongPress({ onPress: vi.fn() });
  const onSheetItem = vi.fn();
  const item = document.createElement('button');
  item.addEventListener('click', onSheetItem);
  document.body.append(item);

  press.start(pointer());
  vi.advanceTimersByTime(LONG_PRESS_MS);
  press.end(pointer());
  window.dispatchEvent(new PointerEvent('pointerup'));
  item.click();
  item.click();

  expect(onSheetItem).not.toHaveBeenCalled();

  vi.advanceTimersByTime(500);
  item.click();
  expect(onSheetItem).toHaveBeenCalledOnce();

  item.remove();
  vi.useRealTimers();
});

test('a touch contextmenu is prevented and left to the long press', () => {
  const handler = vi.fn();
  const menu = new PointerEvent('contextmenu', { cancelable: true, pointerType: 'touch' });

  mouseContextMenu(handler)(menu);

  expect(handler).not.toHaveBeenCalled();
  expect(menu.defaultPrevented).toBe(true);
});

test('a mouse or keyboard contextmenu reaches the handler', () => {
  const handler = vi.fn();
  const right = new PointerEvent('contextmenu', { cancelable: true, pointerType: 'mouse' });
  const key = new MouseEvent('contextmenu', { cancelable: true });

  mouseContextMenu(handler)(right);
  mouseContextMenu(handler)(key);

  expect(handler).toHaveBeenCalledTimes(2);
});

test('a contextmenu with an empty pointer type is suppressed during touch', () => {
  vi.useFakeTimers();
  const stopGuard = guardTouchClicks();
  const handler = vi.fn();
  try {
    window.dispatchEvent(
      new PointerEvent('pointerdown', { isPrimary: true, pointerType: 'touch' })
    );
    const menu = new PointerEvent('contextmenu', { cancelable: true, pointerType: '' });
    mouseContextMenu(handler)(menu);

    expect(handler).not.toHaveBeenCalled();
    expect(menu.defaultPrevented).toBe(true);
  } finally {
    stopGuard();
  }
});

test('a touch press is held until it lifts or fires', () => {
  vi.useFakeTimers();
  const press = new LongPress({ onPress: vi.fn() });

  press.start(pointer());
  expect(press.pressing).toBe(true);
  press.end(pointer());
  expect(press.pressing).toBe(false);

  press.start(pointer());
  vi.advanceTimersByTime(LONG_PRESS_MS);
  expect(press.pressing).toBe(false);

  press.start(pointer({ pointerType: 'mouse' }));
  expect(press.pressing).toBe(false);
  vi.useRealTimers();
});

test('a touch contextmenu after the platform cancels the hold fires the press', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const node = document.createElement('a');
  const detach = longPress({ onPress })(node);

  node.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(new PointerEvent('pointercancel', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(new PointerEvent('contextmenu', { pointerType: 'touch' }));

  expect(onPress).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(onPress).toHaveBeenCalledOnce();
  detach();
  vi.useRealTimers();
});

test('a platform cancel after its own contextmenu fires the press', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const node = document.createElement('a');
  const detach = longPress({ onPress })(node);

  node.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(new PointerEvent('contextmenu', { pointerType: 'touch' }));
  expect(onPress).not.toHaveBeenCalled();
  node.dispatchEvent(new PointerEvent('pointercancel', { isPrimary: true, pointerType: 'touch' }));

  expect(onPress).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(onPress).toHaveBeenCalledOnce();
  detach();
  vi.useRealTimers();
});

test('a lift after the platform contextmenu opens nothing', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const node = document.createElement('a');
  const detach = longPress({ onPress })(node);

  node.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(new PointerEvent('contextmenu', { pointerType: 'touch' }));
  node.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(new PointerEvent('pointercancel', { isPrimary: true, pointerType: 'touch' }));
  vi.advanceTimersByTime(1000);

  expect(onPress).not.toHaveBeenCalled();
  detach();
  vi.useRealTimers();
});

test('a touch contextmenu opens nothing after a lift, a slide or a fired press', () => {
  vi.useFakeTimers();
  const onPress = vi.fn();
  const node = document.createElement('a');
  const detach = longPress({ onPress })(node);
  const menu = () => new PointerEvent('contextmenu', { pointerType: 'touch' });

  node.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(menu());
  expect(onPress).not.toHaveBeenCalled();

  node.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(
    new PointerEvent('pointermove', { isPrimary: true, pointerType: 'touch', clientY: 40 })
  );
  node.dispatchEvent(menu());
  expect(onPress).not.toHaveBeenCalled();

  node.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, pointerType: 'touch' }));
  node.dispatchEvent(menu());
  expect(onPress).not.toHaveBeenCalled();
  vi.advanceTimersByTime(LONG_PRESS_MS);
  node.dispatchEvent(menu());
  expect(onPress).toHaveBeenCalledOnce();
  detach();
  vi.useRealTimers();
});
