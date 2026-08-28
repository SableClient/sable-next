// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';

import LogList from './log-list.svelte';
import { debugLog, recordDebugLog, setDebugLogging } from './debug-log.svelte.js';

const originalWarn = console.warn;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

test('logging with nothing watching schedules no reactive work', () => {
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame');
  setDebugLogging(true);

  try {
    for (let index = 0; index < 100; index += 1) {
      recordDebugLog('debug', 'network', 'transport', `command ${index}`);
    }

    expect(frame).not.toHaveBeenCalled();
    expect(debugLog.entries.length).toBeGreaterThanOrEqual(100);
  } finally {
    frame.mockRestore();
    setDebugLogging(false);
  }
});

test('entries arriving across separate tasks notify a reader once per frame', async () => {
  setDebugLogging(true);
  let runs = 0;
  const stop = $effect.root(() => {
    $effect(() => {
      runs += 1;
      void debugLog.entries.length;
    });
  });

  try {
    flushSync();
    const settled = runs;

    for (let index = 0; index < 5; index += 1) {
      recordDebugLog('debug', 'network', 'transport', `burst ${index}`);
      flushSync();
    }
    expect(runs).toBe(settled);

    await nextFrame();
    flushSync();

    expect(runs).toBe(settled + 1);
  } finally {
    stop();
    setDebugLogging(false);
  }
});

test('a logging call site inside an effect is not subscribed to the store', async () => {
  setDebugLogging(true);
  let runs = 0;
  const stop = $effect.root(() => {
    $effect(() => {
      runs += 1;
      recordDebugLog('debug', 'network', 'transport', `command ${runs}`);
    });
  });

  try {
    flushSync();
    const settled = runs;

    console.info('an unrelated entry');
    await nextFrame();
    flushSync();

    expect(runs).toBe(settled);
  } finally {
    stop();
    setDebugLogging(false);
  }
});

test('console output during render does not feed back into the log store', async () => {
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
  };

  setDebugLogging(true);
  console.info('seed entry');
  const before = debugLog.entries.length;
  expect(before).toBeGreaterThan(0);

  const target = document.createElement('div');
  document.body.appendChild(target);
  const warnDuringRender = (): void => {
    console.warn('[svelte] state_unsafe_mutation');
  };
  const component = mount(LogList, { target, props: { warn: warnDuringRender } });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(debugLog.entries.length - before).toBeLessThanOrEqual(1);
  } finally {
    await unmount(component);
    target.remove();
    setDebugLogging(false);
    console.warn = originalWarn;
  }
});
