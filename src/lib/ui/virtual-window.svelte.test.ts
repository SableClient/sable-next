// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import { VirtualWindow } from './virtual-window.svelte';

let rows = $state([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
let cleanup = (): void => {};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
});

function mount(): { rowWindow: VirtualWindow; detach: () => void } {
  let rowWindow!: VirtualWindow;
  cleanup = $effect.root(() => {
    rowWindow = new VirtualWindow(() => ({
      count: rows.length,
      key: (index) => rows[index].key,
      estimate: 10,
      overscan: 5,
    }));
  });
  const scroller = document.createElement('div');
  document.body.append(scroller);
  const detach = rowWindow.scroller(scroller) as () => void;
  expect(rowWindow.items.map(({ key }) => key)).toEqual(['a', 'b', 'c']);
  return { rowWindow, detach };
}

function row(index: number, height: number): HTMLElement {
  const element = document.createElement('div');
  element.dataset.index = String(index);
  Object.defineProperty(element, 'offsetHeight', { value: height });
  document.body.append(element);
  return element;
}

// An outroing list stops reading its rows, so its last teardown is the first look at the new list.
test('detaching the scroller after the list shrinks only keys rows that still exist', () => {
  const { rowWindow, detach } = mount();
  rowWindow.measure(row(0, 30));

  rows = [{ key: 'a' }];
  flushSync();

  expect(detach).not.toThrow();
  expect(rowWindow.items.map(({ key }) => key)).toEqual(['a']);
});

test('measuring a row past the end of a shrunken list does not throw', () => {
  const { rowWindow } = mount();

  rows = [{ key: 'a' }];
  flushSync();

  expect(() => rowWindow.measure(row(2, 30))).not.toThrow();
  expect(rowWindow.items.map(({ key }) => key)).toEqual(['a']);
});
