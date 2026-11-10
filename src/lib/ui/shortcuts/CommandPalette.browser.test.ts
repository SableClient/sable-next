import { afterEach, expect, test, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { withCounts } from '#lib/rooms/summary-fixtures.js';
import { roomUnread } from '#lib/rooms/unread.js';
import { goto } from '#lib/test-support/app-navigation.js';
import { expectNoA11yViolations } from '#lib/test-support/a11y.js';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  holdOverlayBack: () => {},
  afterOverlayPops: () => Promise.resolve(),
}));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => ({ rooms, unreadFor: roomUnread }),
}));

import CommandPalette from './CommandPalette.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateColorScheme: (scheme: 'light' | 'dark') => Promise<void>;
  }
}

const rooms = ['Alpha', 'Beta'].map((name) =>
  withCounts({
    room_id: `!${name.toLowerCase()}:example.org`,
    name,
    canonical_alias: null,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_tombstoned: false,
    call_participants: [],
    screen_sharers: [],
    room_kind: 'text',
    supports_knock: false,
    supports_restricted: false,
    supports_knock_restricted: false,
    space_children: [],
    bridge: null,
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
  })
);

afterEach(async () => {
  await commands.emulateColorScheme('light');
});

test.each(['light', 'dark'] as const)(
  'arrow keys visibly select the room that Enter opens (%s)',
  async (scheme) => {
    await commands.emulateColorScheme(scheme);
    await render(CommandPalette, { open: true });
    const input = page.getByRole('combobox');
    const dialog = page.getByRole('dialog');
    const alpha = page.getByRole('option', { name: 'Alpha' });
    const beta = page.getByRole('option', { name: 'Beta' });

    function expectHighlight(selected: Element, other: Element): void {
      expect(selected).toHaveAttribute('aria-selected', 'true');
      expect(other).toHaveAttribute('aria-selected', 'false');
      expect(input.element()).toHaveAttribute('aria-activedescendant', selected.id);
      expect(getComputedStyle(selected).backgroundColor).not.toBe(
        getComputedStyle(dialog.element()).backgroundColor
      );
      expect(getComputedStyle(other).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }

    await expect.element(alpha).toBeVisible();
    await userEvent.click(input);
    expectHighlight(alpha.element(), beta.element());
    await userEvent.keyboard('{ArrowDown}');
    expectHighlight(beta.element(), alpha.element());
    await expectNoA11yViolations(document.body);
    await userEvent.keyboard('{ArrowUp}');
    expectHighlight(alpha.element(), beta.element());
    await userEvent.keyboard('{ArrowUp}');
    expectHighlight(beta.element(), alpha.element());
    await userEvent.keyboard('{Enter}');
    expect(goto).toHaveBeenCalledWith('/rooms/!beta%3Aexample.org');
  }
);
