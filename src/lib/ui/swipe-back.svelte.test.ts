import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock('./motion.js', () => ({
  MOTION_MS: { medium: 350 },
  motionMs: (duration: number) => (motion.reduced ? 0 : duration),
}));

import { SwipeBack } from './swipe-back.svelte';

function touch(clientX: number, timeStamp: number): TouchEvent {
  return {
    timeStamp,
    target: null,
    currentTarget: null,
    touches: [{ clientX, clientY: 100 }] as unknown as TouchList,
  } as unknown as TouchEvent;
}

function drag(swipe: SwipeBack, to: number, duration: number): void {
  swipe.start(touch(0, 0));
  swipe.move(touch(10, 10));
  swipe.move(touch(to, duration));
}

describe('SwipeBack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    motion.reduced = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('slides a released page out before dismissing it', () => {
    const onDismiss = vi.fn();
    const swipe = new SwipeBack({ width: () => 400, onDismiss });
    drag(swipe, 300, 2000);
    swipe.finish(false);

    expect(swipe.transform).toBe('translateX(100%)');
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('springs back a short drag and keeps it moved until the spring settles', () => {
    const onDismiss = vi.fn();
    const swipe = new SwipeBack({ width: () => 400, onDismiss });
    drag(swipe, 40, 2000);
    swipe.finish(false);

    expect(swipe.transform).toBeUndefined();
    expect(swipe.moved).toBe(true);
    vi.advanceTimersByTime(350);
    expect(swipe.moved).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses at once under reduced motion', () => {
    motion.reduced = true;
    const onDismiss = vi.fn();
    const swipe = new SwipeBack({ width: () => 400, onDismiss });
    swipe.dismiss();

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(swipe.leaving).toBe(false);
  });

  it('holds the offset when the surface closes by itself', () => {
    const onDismiss = vi.fn();
    const swipe = new SwipeBack({ width: () => 400, onDismiss, slideOut: false });
    drag(swipe, 300, 2000);
    swipe.finish(false);

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(swipe.transform).toBe('translateX(300px)');
  });

  it('ignores a second dismiss while leaving', () => {
    const onDismiss = vi.fn();
    const swipe = new SwipeBack({ width: () => 400, onDismiss });
    swipe.dismiss();
    swipe.dismiss();
    vi.advanceTimersByTime(700);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
