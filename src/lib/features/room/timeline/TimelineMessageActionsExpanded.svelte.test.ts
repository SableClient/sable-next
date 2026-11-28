// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { setPreference } from '#lib/settings/preferences.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import { core, user, press, hover, resetTimelineItemTest, item } from './timeline-item-fixtures';
import { withRowFields } from './row-fixtures.js';

afterEach(async () => {
  await user.keyboard('{/Shift}');
  setPreference('expandedMessageActions', false);
  setPreference('messageActionReactions', true);
  core.rpc.messages.frequentReactions.mockResolvedValue([]);
  resetTimelineItemTest();
});

const receipts = () => screen.queryByRole('button', { name: 'Read receipts' });
const moreActions = () => screen.queryByRole('button', { name: 'More actions' });

async function renderHovered(props: Record<string, unknown> = {}): Promise<void> {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, ...props } },
  });
  await tick();
  await hover(document.querySelector('.message'));
  await tick();
}

async function pressInToolbar(button: HTMLElement): Promise<void> {
  const hitTest = vi.spyOn(document, 'elementFromPoint').mockReturnValue(button);
  try {
    await press(button);
  } finally {
    hitTest.mockRestore();
  }
}

test('holding Shift lists every action in the toolbar and runs the one pressed', async () => {
  await renderHovered();
  expect(receipts()).not.toBeInTheDocument();
  expect(moreActions()).toBeInTheDocument();

  await user.keyboard('{Shift>}');
  await tick();

  expect(moreActions()).not.toBeInTheDocument();
  await pressInToolbar(screen.getByRole('button', { name: 'Read receipts' }));

  expect(await screen.findByRole('dialog')).toBeInTheDocument();
});

test('Shift pressed before hovering still expands the toolbar', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();
  await user.keyboard('{Shift>}');
  await hover(document.querySelector('.message'));
  await tick();

  expect(receipts()).toBeInTheDocument();
});

test('releasing Shift or leaving the window collapses the toolbar', async () => {
  await renderHovered();

  await user.keyboard('{Shift>}');
  await tick();
  expect(receipts()).toBeInTheDocument();
  await user.keyboard('{/Shift}');
  await tick();
  expect(receipts()).not.toBeInTheDocument();

  await user.keyboard('{Shift>}');
  await tick();
  expect(receipts()).toBeInTheDocument();
  await fireEvent(window, new Event('blur'));
  await tick();
  expect(receipts()).not.toBeInTheDocument();
  expect(moreActions()).toBeInTheDocument();
});

test('Shift with another modifier leaves the toolbar alone', async () => {
  await renderHovered();

  await user.keyboard('{Control>}{Shift>}');
  await tick();

  expect(receipts()).not.toBeInTheDocument();
  await user.keyboard('{/Shift}{/Control}');
});

test('the setting keeps the toolbar expanded without Shift', async () => {
  setPreference('expandedMessageActions', true);
  await renderHovered({ onReply: vi.fn() });

  expect(receipts()).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  expect(moreActions()).not.toBeInTheDocument();
});

test('Shift does not swap the toolbar under its open overflow menu', async () => {
  await renderHovered();
  await pressInToolbar(screen.getByRole('button', { name: 'More actions' }));
  await tick();
  expect(screen.getByRole('menu')).toBeInTheDocument();

  await user.keyboard('{Shift>}');
  await tick();

  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(receipts()).not.toBeInTheDocument();
});

test('deleting from the expanded toolbar still asks first', async () => {
  const onDelete = vi.fn();
  setPreference('expandedMessageActions', true);
  await renderHovered({
    item: withRowFields({ ...item(false), is_own: true }),
    canRedactOwn: true,
    onDelete,
  });

  await pressInToolbar(screen.getByRole('button', { name: 'Delete message' }));

  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(onDelete).not.toHaveBeenCalled();
});

test('a keyboard-focused toolbar stays expanded until focus leaves it', async () => {
  await renderHovered();
  await user.keyboard('{Shift>}');
  await tick();
  screen.getByRole('button', { name: 'Read receipts' }).focus();
  await user.keyboard('{/Shift}');
  await tick();
  expect(receipts()).toBeInTheDocument();

  document.querySelector<HTMLElement>('article.message')?.focus();
  await tick();
  expect(receipts()).not.toBeInTheDocument();
  expect(moreActions()).toBeInTheDocument();
});

test('Shift typed into a text field leaves the toolbar alone', async () => {
  await renderHovered();
  const field = document.createElement('textarea');
  document.body.append(field);
  field.focus();

  await user.keyboard('{Shift>}A');
  await tick();
  expect(receipts()).not.toBeInTheDocument();

  await user.keyboard('{/Shift}');
  await fireEvent.keyDown(document.body, { key: 'Shift', shiftKey: true, isComposing: true });
  await tick();
  expect(receipts()).not.toBeInTheDocument();
});

test('the toolbar can leave out recent reactions but keeps the reaction picker', async () => {
  core.rpc.messages.frequentReactions.mockResolvedValue(['👍']);
  const quickReaction = () => document.querySelector('.message-actions .quick-reaction');
  await renderHovered({ onToggleReaction: vi.fn() });
  await vi.waitFor(() => {
    expect(quickReaction()).toBeInTheDocument();
  });

  setPreference('messageActionReactions', false);
  await tick();

  expect(quickReaction()).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
});
