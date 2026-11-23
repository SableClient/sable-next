// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import { RoomPanels } from './room-panels.svelte.js';
import RoomHeaderActions from './RoomHeaderActions.svelte';

test.each([
  [false, 1],
  [true, 0],
])('a direct chat (%s) hides the notifications panel button', (direct, count) => {
  render(RoomHeaderActions, {
    panels: new RoomPanels(),
    voiceView: false,
    direct,
    desktop: true,
    widgetCount: 0,
    canManageWidgets: false,
  });
  expect(screen.queryAllByRole('button', { name: 'Notifications in this room' })).toHaveLength(
    count
  );
});

test('a panel button shows its panel open once pressed', async () => {
  render(RoomHeaderActions, {
    panels: new RoomPanels(),
    voiceView: false,
    direct: false,
    desktop: true,
    widgetCount: 0,
    canManageWidgets: false,
  });
  const threads = screen.getByRole('button', { name: 'Threads' });

  await fireEvent.click(threads);

  expect(threads).toHaveAttribute('aria-pressed', 'true');
});

test('the compact thread shortcut announces its unread thread count', () => {
  render(RoomHeaderActions, {
    panels: new RoomPanels(),
    voiceView: false,
    direct: false,
    desktop: false,
    widgetCount: 2,
    canManageWidgets: false,
    threadsOnly: true,
    threadsUnread: 3,
  });
  const threadButton = screen.getByRole('button', { name: 'Threads, 3 unread threads' });
  expect(threadButton).toHaveTextContent('3');
  expect(screen.getAllByRole('button')).toEqual([threadButton]);
});
