import { afterEach, expect, test, vi } from 'vitest';

import { whenVisible } from './when-visible.js';

const original = globalThis.IntersectionObserver;

afterEach(() => {
  globalThis.IntersectionObserver = original;
});

function stubObserver() {
  const instances: { callback: IntersectionObserverCallback; disconnect: () => void }[] = [];
  globalThis.IntersectionObserver = class {
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = '';
    thresholds = [];
    constructor(callback: IntersectionObserverCallback) {
      instances.push({ callback, disconnect: this.disconnect });
    }
  } as unknown as typeof IntersectionObserver;

  return instances;
}

test('does not fire until the node intersects', () => {
  const instances = stubObserver();
  const onVisible = vi.fn();
  const node = {} as HTMLElement;

  whenVisible(onVisible)(node);
  expect(onVisible).not.toHaveBeenCalled();

  instances[0].callback([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as never);
  expect(onVisible).not.toHaveBeenCalled();

  instances[0].callback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as never);
  expect(onVisible).toHaveBeenCalledOnce();
});

test('stops observing once it has fired', () => {
  const instances = stubObserver();
  const onVisible = vi.fn();

  whenVisible(onVisible)({} as HTMLElement);
  instances[0].callback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as never);
  instances[0].callback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as never);

  expect(onVisible).toHaveBeenCalledOnce();
  expect(instances[0].disconnect).toHaveBeenCalled();
});

test('falls back to loading immediately where the observer is unavailable', () => {
  Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  const onVisible = vi.fn();

  whenVisible(onVisible)({} as HTMLElement);

  expect(onVisible).toHaveBeenCalledOnce();
});

test('a dwell fires only for a node that stays visible', () => {
  vi.useFakeTimers();
  const instances = stubObserver();
  const onVisible = vi.fn();
  const visible = [{ isIntersecting: true }] as IntersectionObserverEntry[];
  const hidden = [{ isIntersecting: false }] as IntersectionObserverEntry[];

  whenVisible(onVisible, '0px', 300)({} as HTMLElement);
  instances[0].callback(visible, {} as never);
  vi.advanceTimersByTime(200);
  instances[0].callback(hidden, {} as never);
  vi.advanceTimersByTime(500);
  expect(onVisible).not.toHaveBeenCalled();

  instances[0].callback(visible, {} as never);
  vi.advanceTimersByTime(300);
  expect(onVisible).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test('a dwell does not fire after the attachment is torn down', () => {
  vi.useFakeTimers();
  const instances = stubObserver();
  const onVisible = vi.fn();

  const teardown = whenVisible(onVisible, '0px', 300)({} as HTMLElement);
  instances[0].callback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as never);
  if (typeof teardown === 'function') teardown();
  vi.advanceTimersByTime(300);

  expect(onVisible).not.toHaveBeenCalled();
  vi.useRealTimers();
});
