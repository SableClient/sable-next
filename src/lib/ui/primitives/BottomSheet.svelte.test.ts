// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { expect, test, vi } from 'vitest';

import BottomSheet from './BottomSheet.svelte';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

function touch(target: Element, type: string, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: { length: 1, item: () => ({ clientX: 0, clientY }) },
  });
  target.dispatchEvent(event);
  return event;
}

async function swipeDownIn(scrollTop: number): Promise<boolean> {
  render(BottomSheet, {
    open: true,
    label: 'Sheet',
    closeLabel: 'Close',
    children: createRawSnippet(() => ({
      render: () =>
        '<ul style="display: flex; flex-direction: row; flex-wrap: wrap-reverse; overflow-y: auto"><li>Item</li></ul>',
    })),
  });
  const item = await screen.findByText('Item');
  const list = item.parentElement as HTMLElement;
  Object.defineProperty(list, 'scrollHeight', { value: 400 });
  Object.defineProperty(list, 'clientHeight', { value: 100 });
  Object.defineProperty(list, 'scrollTop', { value: scrollTop });
  await tick();

  touch(item, 'touchstart', 100);
  return touch(item, 'touchmove', 150).defaultPrevented;
}

test('leaves a downward swipe to a wrap-reverse list resting at its end', async () => {
  expect(await swipeDownIn(0)).toBe(false);
});

test('claims a downward swipe once a wrap-reverse list is scrolled to its top', async () => {
  expect(await swipeDownIn(-300)).toBe(true);
});
