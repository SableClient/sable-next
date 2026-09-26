// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
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

afterEach(() => {
  paletteState.open = false;
});

function setup(props: { mobile?: boolean; compact?: boolean } = { mobile: true }): void {
  render(UserQuickTools, props);
}

test('the mobile bar links navigation and inbox as pages, not overlays', async () => {
  setup();

  const navigate = screen.getByRole('link', { name: 'shortcuts.openRoomSearch' });
  expect(navigate).toHaveAttribute('href', '/navigate');
  await fireEvent.click(navigate);
  expect(paletteState.open).toBe(false);

  const inbox = screen.getByRole('link', { name: 'nav.inbox' });
  expect(inbox).toHaveAttribute('href', '/inbox');
  expect(await fireEvent.click(inbox)).toBe(true);
});

test('the mobile bar keeps a slot per tool', () => {
  setup();

  const bar = screen.getByRole('navigation', { name: 'nav.quickTools' });
  expect(bar.style.getPropertyValue('--mobile-slot-count')).toBe('4');
  expect(bar.querySelectorAll('.mobile-tool-slot')).toHaveLength(4);
});

test('the collapsed sidebar leaves message search to the rail', () => {
  setup({ compact: true });

  expect(screen.getByRole('navigation', { name: 'nav.quickTools' })).toHaveClass('compact-tools');
  expect(screen.queryByRole('link', { name: 'nav.search' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href="/search"]')).not.toBeInTheDocument();
});
