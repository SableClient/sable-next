import { afterEach, describe, expect, test, vi } from 'vitest';

import type { BackwardPaginationState } from '#lib/rooms/timeline.svelte.js';

import { TimelineHistoryController } from './timeline-history';
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
  return { controller, debugLog, requestHistory, state };
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

describe('TimelineHistoryController', () => {
  test('rate limits sparse fills and stops at the page limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const requestHistory = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const { controller } = setup(requestHistory);

    controller.markWheelScroll(wheel(-1));
    expect(requestHistory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TIMELINE_LAYOUT.historyRequestMinInterval * 4);
    expect(requestHistory).toHaveBeenCalledTimes(TIMELINE_LAYOUT.historyFillMaxPages);
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

  test('requires a new upward key gesture after keyup', () => {
    const { controller, requestHistory, state } = setup();
    state.nearOldest = false;

    controller.markKeyScroll(key('ArrowUp'));
    controller.markKeyEnd(key('ArrowUp'));
    state.nearOldest = true;
    controller.refreshQueuedRequest();

    expect(requestHistory).not.toHaveBeenCalled();
    controller.markKeyScroll(key('PageUp'));
    expect(requestHistory).toHaveBeenCalledTimes(1);
  });

  test('requests history for an upward touch gesture and resets on touchend', () => {
    const { controller, requestHistory, state } = setup();
    state.nearOldest = false;

    controller.markTouchStart(touch(100));
    controller.markTouchMove(touch(120));
    controller.markTouchEnd();
    state.nearOldest = true;
    controller.refreshQueuedRequest();

    expect(requestHistory).not.toHaveBeenCalled();
    controller.markTouchStart(touch(100));
    controller.markTouchMove(touch(120));
    expect(requestHistory).toHaveBeenCalledTimes(1);
  });

  test('detaches listeners and clears gesture timers', async () => {
    vi.useFakeTimers();
    const { controller, requestHistory } = setup();
    const node = new EventTarget() as unknown as HTMLDivElement;
    const event = new Event('wheel');
    Object.defineProperty(event, 'deltaY', { value: -1 });
    const detach = controller.attach(node);

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
