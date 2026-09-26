import { expect, test, vi } from 'vitest';

import { DOUBLE_TAP_MS, DoubleTap } from './double-tap.js';

function pointer(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerType: 'touch',
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    target: null,
    ...overrides,
  } as unknown as PointerEvent;
}

function tap(gesture: DoubleTap, at: number, overrides: Partial<PointerEvent> = {}): void {
  gesture.down(pointer({ timeStamp: at, ...overrides }));
  gesture.up(pointer({ timeStamp: at + 50, ...overrides }));
}

test('two quick taps in the same place fire once', () => {
  const onDoubleTap = vi.fn();
  const gesture = new DoubleTap(onDoubleTap);

  tap(gesture, 0);
  expect(onDoubleTap).not.toHaveBeenCalled();
  tap(gesture, 200);
  expect(onDoubleTap).toHaveBeenCalledOnce();

  tap(gesture, 400);
  expect(onDoubleTap).toHaveBeenCalledOnce();
});

test('taps too far apart in time or space do not fire', () => {
  const onDoubleTap = vi.fn();
  const gesture = new DoubleTap(onDoubleTap);

  tap(gesture, 0);
  tap(gesture, 50 + DOUBLE_TAP_MS + 1);
  tap(gesture, 1000);
  tap(gesture, 1200, { clientX: 100 });

  expect(onDoubleTap).not.toHaveBeenCalled();
});

test('a drag, a hold, a cancel or a mouse is not a tap', () => {
  const onDoubleTap = vi.fn();
  const gesture = new DoubleTap(onDoubleTap);

  tap(gesture, 0);
  gesture.down(pointer({ timeStamp: 200 }));
  gesture.up(pointer({ timeStamp: 250, clientY: 40 }));

  tap(gesture, 1000);
  gesture.down(pointer({ timeStamp: 1200 }));
  gesture.up(pointer({ timeStamp: 1200 + DOUBLE_TAP_MS + 1 }));

  tap(gesture, 3000);
  gesture.down(pointer({ timeStamp: 3200 }));
  gesture.cancel();
  gesture.up(pointer({ timeStamp: 3250 }));

  tap(gesture, 5000, { pointerType: 'mouse' });
  tap(gesture, 5200, { pointerType: 'mouse' });

  expect(onDoubleTap).not.toHaveBeenCalled();
});

test('a tap on a control inside the row does not count', () => {
  const onDoubleTap = vi.fn();
  const gesture = new DoubleTap(onDoubleTap);
  const link = document.createElement('a');
  const text = document.createElement('span');
  link.append(text);

  tap(gesture, 0, { target: text });
  tap(gesture, 200, { target: text });
  expect(onDoubleTap).not.toHaveBeenCalled();

  tap(gesture, 1000, { target: document.createElement('p') });
  tap(gesture, 1200, { target: document.createElement('p') });
  expect(onDoubleTap).toHaveBeenCalledOnce();
});
