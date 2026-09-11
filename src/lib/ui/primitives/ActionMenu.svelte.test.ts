// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/rooms' }, params: {}, state: history.state },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));

import ActionMenuHarness from './ActionMenuHarness.test.svelte';

afterEach(() => {
  history.state.overlay = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function narrowViewport(): void {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

async function press(element: Element): Promise<void> {
  element.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
    })
  );
  element.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse' })
  );
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

test('a wide viewport opens the anchored menu', async () => {
  const onPick = vi.fn();
  const instance = mount(ActionMenuHarness, { target: document.body, props: { onPick } });
  await tick();

  const trigger = document.querySelector('.probe-trigger');
  expect(trigger).not.toBeNull();
  if (trigger) await press(trigger);

  expect(document.querySelector('.menu-surface')).not.toBeNull();
  expect(document.querySelector('.dialog-content-sheet')).toBeNull();

  await unmount(instance);
});

test('a narrow viewport opens a bottom sheet, and a submenu pushes a second one', async () => {
  narrowViewport();
  const onPick = vi.fn();
  const instance = mount(ActionMenuHarness, { target: document.body, props: { onPick } });
  await tick();

  const trigger = document.querySelector('.probe-trigger');
  expect(trigger).not.toBeNull();
  if (trigger) await press(trigger);

  expect(document.querySelectorAll('.dialog-content-sheet')).toHaveLength(1);
  expect(document.querySelector('.menu-surface')).toBeNull();

  const rows = [...document.querySelectorAll('[role="menu"] .menu-item')];
  expect(rows.map((row) => row.textContent.trim())).toEqual(['Mark as read', 'Notifications']);

  const submenu = rows[1];
  await press(submenu);

  expect(document.querySelectorAll('.dialog-content-sheet')).toHaveLength(2);
  const checked = document.querySelector('[role="menuitemradio"]');
  expect(checked?.getAttribute('aria-checked')).toBe('true');

  if (checked) await press(checked);

  expect(onPick).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('.dialog-content-sheet')).toHaveLength(0);

  await unmount(instance);
});
