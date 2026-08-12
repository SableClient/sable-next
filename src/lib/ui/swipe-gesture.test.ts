import { describe, expect, it } from 'vitest';
import {
  finishSwipeGesture,
  startSwipeGesture,
  updateSwipeGesture,
  type SwipeGesture,
} from './swipe-gesture';

function touchEvent(clientX: number, clientY: number, timeStamp: number): TouchEvent {
  return {
    timeStamp,
    touches: [{ clientX, clientY }] as unknown as TouchList,
  } as TouchEvent;
}

function horizontalGesture(): SwipeGesture {
  const gesture = startSwipeGesture(touchEvent(100, 100, 0), 0);
  if (!gesture) throw new Error('expected a gesture');
  updateSwipeGesture(gesture, touchEvent(180, 100, 100));
  return gesture;
}

describe('swipe gesture helper', () => {
  it('ignores multi-touch starts and moves', () => {
    const event = {
      timeStamp: 0,
      touches: [
        { clientX: 100, clientY: 100 },
        { clientX: 120, clientY: 100 },
      ],
    } as unknown as TouchEvent;

    expect(startSwipeGesture(event, 0)).toBeUndefined();

    const gesture = startSwipeGesture(touchEvent(100, 100, 0), 0);
    if (!gesture) throw new Error('expected a gesture');
    expect(updateSwipeGesture(gesture, event)).toBeUndefined();
  });

  it('locks a gesture to its initial dominant axis', () => {
    const horizontal = startSwipeGesture(touchEvent(100, 100, 0), 0);
    if (!horizontal) throw new Error('expected a gesture');
    expect(updateSwipeGesture(horizontal, touchEvent(140, 110, 16))?.mode).toBe('horizontal');
    expect(updateSwipeGesture(horizontal, touchEvent(120, 160, 32))?.mode).toBe('horizontal');

    const vertical = startSwipeGesture(touchEvent(100, 100, 0), 0);
    if (!vertical) throw new Error('expected a gesture');
    expect(updateSwipeGesture(vertical, touchEvent(110, 140, 16))?.mode).toBe('vertical');
    expect(updateSwipeGesture(vertical, touchEvent(160, 120, 32))?.mode).toBe('vertical');
  });

  it('resolves fast and distance-based swipes', () => {
    const fastRight = horizontalGesture();
    expect(finishSwipeGesture(fastRight, 20).direction).toBe('right');

    const slowLeft = startSwipeGesture(touchEvent(200, 100, 0), 0);
    if (!slowLeft) throw new Error('expected a gesture');
    updateSwipeGesture(slowLeft, touchEvent(100, 100, 1000));
    expect(finishSwipeGesture(slowLeft, -64).direction).toBe('left');
  });

  it('leaves short, vertical, and cancelled gestures for the consumer to settle', () => {
    const short = startSwipeGesture(touchEvent(100, 100, 0), 0);
    if (!short) throw new Error('expected a gesture');
    updateSwipeGesture(short, touchEvent(120, 100, 1_000));
    expect(finishSwipeGesture(short, 20)).toMatchObject({ handled: true, direction: undefined });

    const vertical = startSwipeGesture(touchEvent(100, 100, 0), 0);
    if (!vertical) throw new Error('expected a gesture');
    updateSwipeGesture(vertical, touchEvent(110, 150, 100));
    expect(finishSwipeGesture(vertical, 20).handled).toBe(false);

    const cancelled = horizontalGesture();
    expect(finishSwipeGesture(cancelled, 20, true).handled).toBe(false);
  });
});
