import { expect, test } from 'vitest';

import { overlayScrollbar } from './overlay-scrollbar';

function scroller(scrollHeight: number, clientHeight: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight });
  return element;
}

test('sizes and moves the thumb with the scroll position', () => {
  const element = scroller(400, 100);
  const thumb = document.createElement('div');
  overlayScrollbar(thumb)(element);
  expect(thumb.hidden).toBe(false);
  expect(thumb.style.height).toBe('25px');
  expect(thumb.style.transform).toBe('translateY(0px)');

  element.scrollTop = 300;
  element.dispatchEvent(new Event('scroll'));
  expect(thumb.style.transform).toBe('translateY(75px)');
});

test('hides the thumb while the content fits', () => {
  const thumb = document.createElement('div');
  overlayScrollbar(thumb)(scroller(100, 100));
  expect(thumb.hidden).toBe(true);
});

test('dragging the thumb scrolls the content', () => {
  const element = scroller(400, 100);
  const thumb = document.createElement('div');
  const cleanup = overlayScrollbar(thumb)(element) as () => void;

  thumb.dispatchEvent(new PointerEvent('pointerdown', { clientY: 0, pointerId: 1 }));
  thumb.dispatchEvent(new PointerEvent('pointermove', { clientY: 25, pointerId: 1 }));
  expect(element.scrollTop).toBe(100);

  thumb.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
  thumb.dispatchEvent(new PointerEvent('pointermove', { clientY: 50, pointerId: 1 }));
  expect(element.scrollTop).toBe(100);

  cleanup();
  thumb.dispatchEvent(new PointerEvent('pointerdown', { clientY: 0, pointerId: 2 }));
  thumb.dispatchEvent(new PointerEvent('pointermove', { clientY: 50, pointerId: 2 }));
  expect(element.scrollTop).toBe(100);
});
