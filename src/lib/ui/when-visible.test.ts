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
