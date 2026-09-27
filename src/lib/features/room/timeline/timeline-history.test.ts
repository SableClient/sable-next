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
  const controller = new TimelineHistoryController({
    getBackwardPagination: () => state.pagination,
    isNearOldest: () => state.nearOldest,
    isScrolling: () => state.scrolling,
    requestHistory,
  });
  return { controller, requestHistory, state };
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
    msSinceRequest: Number.POSITIVE_INFINITY,
  };

  test.for([
    [{}, 'request'],
    [{ wanted: false }, 'wait'],
    [{ pagination: 'end' as BackwardPaginationState }, 'stop'],
    [{ pagination: 'loading' as BackwardPaginationState }, 'wait'],
    [{ nearOldest: false }, 'stop'],
    [{ requestPending: true }, 'wait'],
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
    const { controller } = setup(requestHistory);

    controller.markWheelScroll(wheel(-1));
    controller.destroy();
    request.resolve(false);
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(controller.isRequestPending).toBe(false);
    expect(requestHistory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
