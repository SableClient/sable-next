import { expect, test } from 'vitest';

import { scrollHint, scrollHintX } from './scroll-hint';

function scroller(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight });
  element.scrollTop = scrollTop;
  return element;
}

function sideScroller(scrollWidth: number, clientWidth: number, scrollLeft: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollWidth', { value: scrollWidth });
  Object.defineProperty(element, 'clientWidth', { value: clientWidth });
  element.scrollLeft = scrollLeft;
  return element;
}

test('marks only the edge that has more content', () => {
  const element = scroller(300, 100, 0);
  scrollHint(element);
  expect(element.dataset.scrollMore).toBe('bottom');

  element.scrollTop = 100;
  element.dispatchEvent(new Event('scroll'));
  expect(element.dataset.scrollMore).toBe('top bottom');

  element.scrollTop = 200;
  element.dispatchEvent(new Event('scroll'));
  expect(element.dataset.scrollMore).toBe('top');
});

test('leaves content that fits unmarked and cleans up', () => {
  const fits = scroller(100, 100, 0);
  scrollHint(fits);
  expect(fits.dataset.scrollMore).toBeUndefined();

  const element = scroller(300, 100, 0);
  const cleanup = scrollHint(element) as () => void;
  cleanup();
  expect(element.dataset.scrollMore).toBeUndefined();
});

test('marks only the inline edge that has more content', () => {
  const element = sideScroller(300, 100, 0);
  scrollHintX(element);
  expect(element.dataset.scrollMoreX).toBe('end');
  expect(element.dataset.scrollMore).toBeUndefined();

  element.scrollLeft = 100;
  element.dispatchEvent(new Event('scroll'));
  expect(element.dataset.scrollMoreX).toBe('start end');

  element.scrollLeft = 200;
  element.dispatchEvent(new Event('scroll'));
  expect(element.dataset.scrollMoreX).toBe('start');
});

test('reads a negative scroll offset as distance from the start', () => {
  const element = sideScroller(300, 100, 0);
  Object.defineProperty(element, 'scrollLeft', { value: -200 });
  scrollHintX(element);
  expect(element.dataset.scrollMoreX).toBe('start');
});
