import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishSwipeGesture,
  startSwipeGesture,
  startsInHorizontalScroller,
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

  it('waits for deliberate movement before locking an axis', () => {
    const gesture = startSwipeGesture(touchEvent(100, 100, 0), 0);
    if (!gesture) throw new Error('expected a gesture');

    expect(updateSwipeGesture(gesture, touchEvent(104, 103, 16))?.mode).toBe('pending');
    expect(updateSwipeGesture(gesture, touchEvent(112, 104, 32))?.mode).toBe('horizontal');
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

describe('a swipe that starts inside a horizontal scroller', () => {
  function node(scrollWidth: number, clientWidth: number, overflowX: string): HTMLElement {
    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollWidth', { value: scrollWidth });
    Object.defineProperty(element, 'clientWidth', { value: clientWidth });
    overflow.set(element, overflowX);
    return element;
  }

  const overflow = new Map<Element, string>();

  beforeEach(() => {
    overflow.clear();
    vi.stubGlobal('getComputedStyle', (element: Element) => ({
      overflowX: overflow.get(element) ?? 'visible',
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is refused, so the formatting bar can scroll without opening the drawer', () => {
    const root = document.createElement('div');
    const bar = node(400, 200, 'auto');
    const button = document.createElement('button');
    bar.append(button);
    root.append(bar);

    expect(startsInHorizontalScroller(button, root)).toBe(true);
  });

  it('is allowed when the ancestor has nothing to scroll', () => {
    const root = document.createElement('div');
    const bar = node(200, 200, 'auto');
    const button = document.createElement('button');
    bar.append(button);
    root.append(bar);

    expect(startsInHorizontalScroller(button, root)).toBe(false);
  });

  it('is allowed when the overflow is clipped rather than scrollable', () => {
    const root = document.createElement('div');
    const bar = node(400, 200, 'hidden');
    const button = document.createElement('button');
    bar.append(button);
    root.append(bar);

    expect(startsInHorizontalScroller(button, root)).toBe(false);
  });

  it('stops at the gesture root rather than walking the whole document', () => {
    const outer = node(400, 200, 'auto');
    const root = document.createElement('div');
    const button = document.createElement('button');
    root.append(button);
    outer.append(root);

    expect(startsInHorizontalScroller(button, root)).toBe(false);
  });
});
