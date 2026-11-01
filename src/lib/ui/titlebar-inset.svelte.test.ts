import { afterEach, expect, test, vi } from 'vitest';

import { collisionPadding, trackTitlebarHeight } from './titlebar-inset.svelte.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the title bar height pads the top while it is mounted', () => {
  let notify = (): void => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe(): void {}
      disconnect(): void {}
    }
  );

  expect(collisionPadding(8)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });

  const stop = trackTitlebarHeight({ offsetHeight: 32 } as HTMLElement);
  notify();
  expect(collisionPadding(8)).toEqual({ top: 40, right: 8, bottom: 8, left: 8 });

  stop();
  expect(collisionPadding()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});
