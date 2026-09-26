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
vi.mock('#lib/ui/primitives/Tooltip.svelte', () => import('./TooltipStub.test.svelte'));
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

function render(props: { mobile?: boolean; compact?: boolean } = { mobile: true }): void {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(UserQuickTools, { target, props });
  dispose = () => void unmount(component);
}

test('the mobile bar links navigation and inbox as pages, not overlays', () => {
  render();

  const navigate = document.querySelector<HTMLAnchorElement>(
    'a[aria-label="shortcuts.openRoomSearch"]'
  );
  expect(navigate?.getAttribute('href')).toBe('/navigate');
  navigate?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(paletteState.open).toBe(false);

  const inbox = document.querySelector<HTMLAnchorElement>('.mobile-tools a[href="/inbox"]');
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  inbox?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
});

test('the mobile bar keeps a slot per tool', () => {
  render();

  const bar = document.querySelector<HTMLElement>('.mobile-tools');
  expect(bar?.style.getPropertyValue('--mobile-slot-count')).toBe('4');
  expect(document.querySelectorAll('.mobile-tool-slot')).toHaveLength(4);
});

test('the collapsed sidebar leaves message search to the rail', () => {
  render({ compact: true });

  expect(document.querySelector('.compact-tools')).not.toBeNull();
  expect(document.querySelector('a[href="/search"]')).toBeNull();
});
