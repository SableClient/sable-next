import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  TimelineDebugRecorder,
  timelineDebugSnapshot,
  type TimelineDebugSample,
} from './timeline-debug';

function sample(time: number, values: Partial<TimelineDebugSample> = {}): TimelineDebugSample {
  return {
    time,
    scrollTop: 0,
    scrollHeight: 100,
    contentDelta: 0,
    distanceFromEnd: 0,
    frameDuration: 0,
    maxFrameDuration: 0,
    frameDelta: 0,
    maxFrameDelta: 0,
    anchorKey: null,
    anchorTop: null,
    visualDelta: 0,
    maxVisualDelta: 0,
    anchorResidual: 0,
    maxAnchorResidual: 0,
    anchorGuard: 'none',
    anchorCorrection: null,
    selfWrite: null,
    firstVirtualIndex: null,
    lastVirtualIndex: null,
    isScrolling: false,
    scrollMode: 'followingLive',
    backwardPagination: 'idle',
    ...values,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TimelineDebugRecorder', () => {
  test('retains the latest 1800 samples', () => {
    const recorder = new TimelineDebugRecorder();
    for (let index = 0; index <= 1_800; index += 1) recorder.add(sample(index));
    expect(recorder.latest()?.time).toBe(1_800);
  });

  test('copies bounded transitions and frame extremes', async () => {
    const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const recorder = new TimelineDebugRecorder();
    recorder.add(sample(1));
    recorder.add(sample(2, { frameDelta: -150, frameDuration: 30 }));

    await recorder.copyTrace();

    const trace = JSON.parse(writeText.mock.calls[0][0]) as {
      samples: number;
      largestFrame: TimelineDebugSample;
      slowestFrame: TimelineDebugSample;
      transitions: TimelineDebugSample[];
    };
    expect(trace.samples).toBe(2);
    expect(trace.largestFrame.time).toBe(2);
    expect(trace.slowestFrame.time).toBe(2);
    expect(trace.transitions.map(({ time }) => time)).toEqual([1, 2]);
  });
});

test('timelineDebugSnapshot selects the first fully visible item', () => {
  const hidden = {
    dataset: { itemId: 'hidden' },
    getBoundingClientRect: () => ({ top: -20, bottom: 20 }),
  };
  const visible = {
    dataset: { itemId: 'visible', eventId: '$event', index: '4' },
    getBoundingClientRect: () => ({ top: 20, bottom: 60 }),
  };
  const viewport = {
    scrollTop: 40,
    scrollHeight: 400,
    clientHeight: 100,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [hidden, visible],
  } as unknown as HTMLDivElement;
  const virtualizer = {
    isScrolling: true,
    getVirtualItems: () => [
      { index: 3, key: 'three', start: 0, end: 40 },
      { index: 4, key: 'four', start: 40, end: 80 },
    ],
  };

  expect(timelineDebugSnapshot(viewport, virtualizer, 'readingHistory')).toEqual({
    scrollTop: 40,
    scrollHeight: 400,
    clientHeight: 100,
    firstVirtualIndex: 3,
    lastVirtualIndex: 4,
    anchor: { id: 'visible', eventId: '$event', index: '4', top: 20, bottom: 60 },
    scrollMode: 'readingHistory',
  });
});
