import { expect, test } from 'vitest';

import { scrollHint } from './scroll-hint';

function scroller(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight });
  element.scrollTop = scrollTop;
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
