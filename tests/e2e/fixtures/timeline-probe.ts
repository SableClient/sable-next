import type { Locator } from '@playwright/test';

declare global {
  interface Window {
    __e2eGestureReady: boolean;
    __e2eGestureActive: boolean;
    __e2eSelfWrites: number;
    __e2eUnexpectedScrolls: string[];
    __e2eRevealReport: Promise<{ gaps: number[]; readerTops: number[]; hiddenAgain: boolean }>;
  }
}

export async function startGestureSample(
  viewport: Locator,
  options: { frames: number; quietFrames: number }
) {
  await viewport.evaluate(() => {
    window.__e2eGestureReady = false;
    window.__e2eGestureActive = true;
  });
  const result = viewport.evaluate(sampleGesture, options);
  await viewport.page().waitForFunction(() => window.__e2eGestureReady);
  return {
    async finish() {
      await viewport.evaluate(() => {
        window.__e2eGestureActive = false;
      });
      return result;
    },
  };
}

export function instrumentSelfWrites(viewport: HTMLElement): void {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (!descriptor?.get || !descriptor.set) throw new Error('scrollTop is not an accessor');
  const read = (element: Element): number => Number(descriptor.get?.call(element));
  const write = (element: Element, value: number): void => descriptor.set?.call(element, value);
  const record = { writes: 0 };
  Object.defineProperty(window, '__e2eSelfWrites', {
    configurable: true,
    get: () => record.writes,
    set: (value: number) => {
      record.writes = value;
    },
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return read(this);
    },
    set(this: Element, value: number) {
      const before = read(this);
      write(this, value);
      record.writes += read(this) - before;
    },
  });
  window.__e2eUnexpectedScrolls = [];
  for (const method of ['scroll', 'scrollTo', 'scrollBy'] as const) {
    const native = viewport[method].bind(viewport);
    viewport[method] = ((...args: [number, number] | [ScrollToOptions]) => {
      const options = typeof args[0] === 'object' ? args[0] : null;
      if (options?.behavior === 'smooth') window.__e2eUnexpectedScrolls.push(method);
      const before = read(viewport);
      if (options) native(options);
      else native(args[0] as number, args[1] as number);
      record.writes += read(viewport) - before;
    }) as typeof viewport.scrollBy;
  }
}

export async function sampleGesture(
  viewport: HTMLElement,
  { frames, quietFrames }: { frames: number; quietFrames: number }
) {
  const bounds = viewport.getBoundingClientRect();
  const anchor = Array.from(viewport.querySelectorAll<HTMLElement>('.item[data-event-id]')).find(
    (row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    }
  );
  if (!anchor) throw new Error('no fully visible row to anchor on');
  const content = anchor.firstElementChild ?? anchor;
  let top = content.getBoundingClientRect().top;
  let scrollTop = viewport.scrollTop;
  let writes = window.__e2eSelfWrites;
  const initialUnexpected = window.__e2eUnexpectedScrolls.length;
  let frameError = 0;
  let readerMovement = 0;
  let drift = 0;
  let clamped = scrollTop === 0;
  let moved = false;
  let quiet = 0;
  window.__e2eGestureReady = true;
  for (
    let frame = 0;
    frame < frames && (window.__e2eGestureActive || !moved || quiet < quietFrames);
    frame += 1
  ) {
    await new Promise(requestAnimationFrame);
    if (!anchor.isConnected) throw new Error('the row the reader was on was unmounted');
    const nextTop = content.getBoundingClientRect().top;
    const nextScrollTop = viewport.scrollTop;
    const nextWrites = window.__e2eSelfWrites;
    const byReader = nextScrollTop - scrollTop - (nextWrites - writes);
    drift += nextTop - top + byReader;
    frameError = Math.max(frameError, Math.abs(drift));
    readerMovement += byReader;
    if (nextScrollTop === 0) clamped = true;
    if (byReader !== 0) moved = true;
    quiet = byReader === 0 ? quiet + 1 : 0;
    top = nextTop;
    scrollTop = nextScrollTop;
    writes = nextWrites;
  }
  return {
    frameError,
    readerMovement,
    clamped,
    moved,
    unexpectedScrolls: window.__e2eUnexpectedScrolls.slice(initialUnexpected),
  };
}
