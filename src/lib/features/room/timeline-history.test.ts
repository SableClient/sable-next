import { afterEach, describe, expect, test, vi } from 'vitest';

import type { BackwardPaginationState } from '#lib/rooms/timeline.svelte.js';

import { nextHistoryDecision, TimelineHistoryController } from './timeline-history';
import { TIMELINE_LAYOUT } from './timeline-layout';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function setup(requestHistory = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)) {
  const state = {
    pagination: 'idle' as BackwardPaginationState,
    nearOldest: true,
    scrolling: false,
  };
  const debugLog = vi.fn<(event: string, details: object) => void>();
  const gestureSettled = vi.fn<() => void>();
  const controller = new TimelineHistoryController({
    getBackwardPagination: () => state.pagination,
    isNearOldest: () => state.nearOldest,
    isVirtualizerScrolling: () => state.scrolling,
    requestHistory,
    onGestureSettled: gestureSettled,
    debugLog,
    debugSnapshot: () => ({ scrollTop: 0 }),
  });
  return { controller, debugLog, gestureSettled, requestHistory, state };
}

function wheel(deltaY: number): WheelEvent {
  return { deltaY } as WheelEvent;
}

function key(value: string): KeyboardEvent {
  return { key: value } as KeyboardEvent;
}

function touch(value: number): TouchEvent {
  return {
    touches: { item: () => ({ clientY: value }) },
  } as unknown as TouchEvent;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('nextHistoryDecision', () => {
  const base = {
    wanted: true,
    pagination: 'idle' as BackwardPaginationState,
    nearOldest: true,
    requestPending: false,
    anchorSuppressed: false,
    anchorFailing: false,
    msSinceRequest: Number.POSITIVE_INFINITY,
  };

  test.for([
    [{}, 'request'],
    [{ wanted: false }, 'wait'],
    [{ pagination: 'end' as BackwardPaginationState }, 'stop'],
    [{ pagination: 'loading' as BackwardPaginationState }, 'wait'],
    [{ nearOldest: false }, 'stop'],
    [{ requestPending: true }, 'wait'],
    [{ anchorSuppressed: true }, 'defer'],
    [{ anchorFailing: true }, 'stop'],
    [{ msSinceRequest: 0 }, 'wait'],
  ] as const)('%o decides %s', ([overrides, decision]) => {
    expect(nextHistoryDecision({ ...base, ...overrides })).toBe(decision);
  });
});

describe('TimelineHistoryController', () => {
  test('rate limits sparse fills and continues until the server reports the end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let pages = 0;
    const requestHistory = vi.fn<() => Promise<boolean>>(() => Promise.resolve((pages += 1) >= 25));
    const { controller } = setup(requestHistory);

    controller.markWheelScroll(wheel(-1));
    expect(requestHistory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TIMELINE_LAYOUT.historyRequestMinInterval * 30);
    expect(requestHistory).toHaveBeenCalledTimes(25);
  });

  test('cancels a sparse fill when input moves toward latest', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const requestHistory = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const { controller } = setup(requestHistory);

    controller.markWheelScroll(wheel(-1));
    await Promise.resolve();
    controller.markWheelScroll(wheel(1));
    await vi.advanceTimersByTimeAsync(TIMELINE_LAYOUT.historyRequestMinInterval * 2);

    expect(requestHistory).toHaveBeenCalledTimes(1);
  });

  test('serves an intent the key gesture could not, once the reader arrives', () => {
    const { controller, requestHistory, state } = setup();
    state.nearOldest = false;

    controller.markKeyScroll(key('ArrowUp'));
    controller.markKeyEnd(key('ArrowUp'));
    expect(requestHistory).not.toHaveBeenCalled();

    state.nearOldest = true;
    controller.observeScroll(true, false);
    expect(requestHistory).toHaveBeenCalledTimes(1);
  });

  test('requests history on momentum after the finger has left', () => {
    const { controller, requestHistory, state } = setup();
    state.nearOldest = false;

    controller.markTouchStart(touch(100));
    controller.markTouchMove(touch(120));
    controller.markTouchEnd();
    expect(requestHistory).not.toHaveBeenCalled();

    state.nearOldest = true;
    controller.observeScroll(true, false);
    expect(requestHistory).toHaveBeenCalledTimes(1);
  });

  test('requests history for an offset that raised no device gesture', () => {
    const { controller, requestHistory } = setup();

    controller.observeScroll(false, false);

    expect(requestHistory).toHaveBeenCalledTimes(1);
  });

  test('leaves a room sitting at both ends alone', () => {
    const { controller, requestHistory } = setup();

    controller.observeScroll(false, true);

    expect(requestHistory).not.toHaveBeenCalled();
  });

  test('downward input cancels an intent the position would not renew', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { controller, requestHistory, state } = setup();
    state.nearOldest = false;

    controller.markWheelScroll(wheel(-1));
    controller.markWheelScroll(wheel(1));
    state.nearOldest = true;
    controller.observeScroll(false, true);
    await vi.runAllTimersAsync();

    expect(requestHistory).not.toHaveBeenCalled();
  });

  test('anchor failures brake the fill they happened in, and no later one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const requestHistory = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const { controller } = setup(requestHistory);

    controller.markWheelScroll(wheel(-1));
    await Promise.resolve();
    controller.suspendForAnchor();
    controller.resumeAfterAnchor(40);
    controller.suspendForAnchor();
    controller.resumeAfterAnchor(40);
    await vi.advanceTimersByTimeAsync(TIMELINE_LAYOUT.historyRequestMinInterval * 4);
    expect(requestHistory).toHaveBeenCalledTimes(1);

    controller.markWheelScroll(wheel(-1));
    expect(requestHistory).toHaveBeenCalledTimes(2);
  });

  test('detaches listeners and clears gesture timers', async () => {
    vi.useFakeTimers();
    const { controller, requestHistory } = setup();
    const node = new EventTarget() as unknown as HTMLDivElement;
    const event = new Event('wheel');
    Object.defineProperty(event, 'deltaY', { value: -1 });
    const detach = controller.attach(node);
    await vi.advanceTimersByTimeAsync(0);

    node.dispatchEvent(event);
    expect(requestHistory).toHaveBeenCalledTimes(1);
    detach();
    node.dispatchEvent(event);
    await vi.runAllTimersAsync();

    expect(requestHistory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('ignores a request that settles after destruction', async () => {
    vi.useFakeTimers();
    const request = deferred<boolean>();
    const requestHistory = vi.fn(() => request.promise);
    const { controller, debugLog } = setup(requestHistory);

    controller.markWheelScroll(wheel(-1));
    controller.destroy();
    request.resolve(false);
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(controller.isRequestPending).toBe(false);
    expect(debugLog.mock.calls.map(([event]) => event)).not.toContain('request:settled');
    expect(requestHistory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('middle-button autoscroll', () => {
  test('a middle press is a scrolling gesture, a left press is not', () => {
    const { controller } = setup();
    controller.markPointerStart(0);
    expect(controller.gesture).toBe('press');
    expect(controller.isScrollGestureActive).toBe(false);

    controller.markPointerEnd();
    controller.markPointerStart(1);
    expect(controller.gesture).toBe('autoscroll');
    expect(controller.isScrollGestureActive).toBe(true);
  });

  test('the button coming back up does not end it', () => {
    const { controller } = setup();
    controller.markPointerStart(1);
    controller.markPointerEnd();
    expect(controller.gesture).toBe('autoscroll');
  });

  test('scroll observation does not erase an active autoscroll gesture', () => {
    const { controller } = setup();
    controller.markPointerStart(1);
    controller.clearUserScrollPending();

    expect(controller.gesture).toBe('autoscroll');
    expect(controller.isScrollGestureActive).toBe(true);
  });

  test('a second press ends it and settles the gesture', () => {
    const { controller, gestureSettled } = setup();
    controller.markPointerStart(1);
    controller.clearUserScrollPending();
    expect(gestureSettled).not.toHaveBeenCalled();

    controller.markPointerStart(1);
    expect(controller.gesture).toBe('none');
    expect(controller.isScrollGestureActive).toBe(false);
    expect(gestureSettled).toHaveBeenCalledTimes(1);
  });

  test('a wheel notch ends it and takes over', () => {
    const { controller } = setup();
    controller.markPointerStart(1);
    controller.markWheelScroll(wheel(-10));
    expect(controller.gesture).toBe('wheel');
  });

  test('a key ends it and takes over', () => {
    const { controller } = setup();
    controller.markPointerStart(1);
    controller.markKeyScroll(key('PageUp'));
    expect(controller.gesture).toBe('keys');
  });

  test('ending a gesture that never started is a no-op', () => {
    const { controller } = setup();
    controller.finishAutoscrollGesture();
    expect(controller.gesture).toBe('none');
    controller.markPointerStart(0);
    controller.finishAutoscrollGesture();
    expect(controller.gesture).toBe('press');
  });

  test('a destroyed controller starts no gesture', () => {
    const { controller } = setup();
    controller.destroy();
    controller.markPointerStart(1);
    expect(controller.gesture).toBe('none');
  });
});
