// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const pageState = vi.hoisted(() => ({
  url: { pathname: '/rooms', search: '', hash: '' },
  state: {},
}));

vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key: string) => key });
      return () => {};
    },
  },
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [], notificationMode: () => 'all_messages' }),
}));
vi.mock('#lib/core/context.js');
vi.mock('#lib/ui/primitives/Tooltip.svelte', () => ({ default: () => null }));
vi.mock('./AccountSwitcher.svelte', () => ({ default: () => null }));

import { paletteState } from '#lib/ui/shortcuts/palette-state.svelte.js';
import UserQuickTools from './UserQuickTools.svelte';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  paletteState.open = false;
  document.body.replaceChildren();
});

function render(): void {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(UserQuickTools, { target, props: { mobile: true } });
  dispose = () => void unmount(component);
}

test('the mobile bar opens the room switcher', () => {
  render();

  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="shortcuts.openRoomSearch"]'
  );
  expect(button).not.toBeNull();

  button?.click();
  expect(paletteState.open).toBe(true);
});

test('the mobile bar keeps a slot per tool', () => {
  render();

  const bar = document.querySelector<HTMLElement>('.mobile-tools');
  expect(bar?.style.getPropertyValue('--mobile-slot-count')).toBe('4');
  expect(document.querySelectorAll('.mobile-tool-slot')).toHaveLength(4);
});
