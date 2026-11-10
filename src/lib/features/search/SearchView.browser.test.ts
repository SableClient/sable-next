import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type {
  CoreEvent,
  RoomListItemView,
  SearchCoverageView,
  SearchHitView,
} from '#src/generated/protocol';

import { withCounts } from '#lib/rooms/summary-fixtures.js';

import en from '../../../locales/en.json' with { type: 'json' };

const core = vi.hoisted((): Record<string, unknown> => ({}));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
  provideCoreClient: vi.fn(),
}));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('../room/messages/event-items.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../room/messages/event-items.svelte.js')>()),
  useEventItems: () => ({ get: () => null }),
}));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    rooms,
    byId: (roomId: string) => rooms.find((room) => room.room_id === roomId),
    labelFor: (roomId: string) => rooms.find((room) => room.room_id === roomId)?.name ?? roomId,
  }),
}));

import SearchView from './SearchView.svelte';

function room(overrides: Partial<RoomListItemView>): RoomListItemView {
  return withCounts({
    room_id: '!id:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: false,
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
    ...overrides,
  });
}

const rooms = [
  room({ room_id: '!general:example.org', name: 'General' }),
  room({ room_id: '!random:example.org', name: 'Random' }),
];

async function mount() {
  let onEvent: ((event: CoreEvent) => void) | undefined;
  const messages = vi.fn().mockResolvedValue({ hits: [], older: null });
  Object.assign(core, {
    session: { user_id: '@me:example.org' },
    searchCoverageUnavailable: false,
    searchCoverage: null,
    refreshSearchCoverage: vi.fn().mockResolvedValue(undefined),
    subscribeEvents: vi.fn((listener: (event: CoreEvent) => void) => {
      onEvent = listener;
      return () => {
        onEvent = undefined;
      };
    }),
    userProfile: vi.fn().mockResolvedValue({ display_name: 'Alice', avatar_url: null }),
    rpc: {
      account: { searchUserDirectory: vi.fn().mockResolvedValue([]) },
      search: { messages },
    },
  });
  const screen = await render(SearchView);
  const field = screen.getByRole('combobox', { name: en.common.searchMessages });
  const listbox = screen.getByRole('listbox', { name: en.search.suggestions });
  const chips = screen.getByRole('list', { name: en.search.activeFilters }).getByRole('listitem');
  return {
    screen,
    field,
    listbox,
    chips,
    messages,
    emitCoverage: (coverage: SearchCoverageView) =>
      onEvent?.({ type: 'search_coverage', coverage }),
  };
}

function hit(eventId: string): SearchHitView {
  return {
    room_id: '!general:example.org',
    event_id: eventId,
    body: 'deploy complete',
    sender: '@alice:example.org',
    origin_server_ts: 1700000000000,
    score: 1,
    context_before: [],
    context_after: [],
  };
}

test('typing an operator prefix offers completions and Tab accepts one', async () => {
  const { field, listbox } = await mount();

  await userEvent.fill(field.element(), 'fr');
  await expect.element(listbox.getByRole('option', { name: /^from:/ })).toBeVisible();

  await userEvent.keyboard('{Tab}');
  await expect.element(field).toHaveValue('from:');
});

test('completing an operator with Tab offers its values', async () => {
  const { field, listbox } = await mount();

  await userEvent.fill(field.element(), 'in');
  await userEvent.keyboard('{Tab}');

  await expect.element(field).toHaveValue('in:');
  await expect.element(listbox.getByRole('option').first()).toBeVisible();
});

test('an operator prefix is not highlighted until the list is arrowed', async () => {
  const { field, listbox } = await mount();

  await userEvent.fill(field.element(), 'fr');
  const option = listbox.getByRole('option', { name: /^from:/ });
  await expect.element(option).toHaveAttribute('aria-selected', 'false');

  await userEvent.keyboard('{ArrowDown}');
  await expect.element(option).toHaveAttribute('aria-selected', 'true');
});

test('Enter searches a word that merely starts an operator', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'turn on');
  await expect.element(screen.getByRole('option', { name: /^on:/ })).toBeVisible();

  await userEvent.keyboard('{Enter}');
  await expect.element(field).toHaveValue('turn on');
  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
});

test('in: offers rooms and accepting one inserts its alias', async () => {
  const { screen, field, chips } = await mount();

  await userEvent.fill(field.element(), 'message in:Ran');
  await userEvent.click(screen.getByRole('option', { name: /Random/ }).first());

  await expect.element(chips).toHaveTextContent('in: Random');
  await expect.element(field).toHaveValue('message ');
});

test('escape dismisses the suggestions without clearing the query', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'has:');
  await expect.element(screen.getByRole('option', { name: 'image' })).toBeVisible();

  await userEvent.keyboard('{Escape}');

  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
  await expect.element(field).toHaveValue('has:');
});

test('escape clears the field only once the suggestions are closed', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'has:im');
  await expect.element(screen.getByRole('listbox')).toBeVisible();

  await userEvent.keyboard('{Escape}');
  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
  await expect.element(field).toHaveValue('has:im');

  await userEvent.keyboard('{Escape}');
  await expect.element(field).toHaveValue('');
});

test('a completed filter does not keep the suggestions open', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'message in:Random ');

  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
});

test('alt+arrowdown offers the operator cheat-sheet on demand', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'message ');
  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();

  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

  await expect.element(screen.getByRole('option', { name: /^in:/ })).toBeVisible();
  await expect.element(screen.getByRole('option', { name: /^during:/ })).toBeVisible();
});

test('alt+arrowdown opens the suggestions without moving focus', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'has:image');
  await userEvent.keyboard('{Escape}');
  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();

  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

  await expect.element(screen.getByRole('listbox')).toBeVisible();
  await expect.element(field).toHaveFocus();
});

test('an operator under the caret stays as text until it is committed', async () => {
  const { field, chips } = await mount();

  await userEvent.fill(field.element(), 'message in:Random');
  await expect.element(chips).not.toBeInTheDocument();
  await expect.element(field).toHaveValue('message in:Random');

  await userEvent.keyboard('{End} ');

  await expect.element(chips).toHaveTextContent('in: Random');
  await expect.element(field).toHaveValue('message ');
});

test('the remove button drops the chip', async () => {
  const { screen, field, chips } = await mount();

  await userEvent.fill(field.element(), 'message in:Random ');
  await expect.element(chips).toHaveTextContent('in: Random');

  await userEvent.click(screen.getByRole('button', { name: 'Remove in:Random' }));

  await expect.element(chips).not.toBeInTheDocument();
});

test('backspace on an empty draft edits the last chip', async () => {
  const { field, chips } = await mount();

  await userEvent.fill(field.element(), 'in:Random in:General ');
  await expect.element(chips).toHaveLength(2);

  await userEvent.keyboard('{Backspace}');

  await expect.element(chips).toHaveLength(1);
  await expect.element(chips).toHaveTextContent('in: Random');
  await expect.element(field).toHaveValue('in:General');
  const input = field.element() as HTMLInputElement;
  expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe('General');
});

test('Shift+Tab leaves suggestions without accepting one', async () => {
  const { field, chips } = await mount();
  await userEvent.fill(field.element(), 'has:');
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  await expect.element(field).toHaveValue('has:');
  await expect.element(chips).not.toBeInTheDocument();
  await expect.element(field).not.toHaveFocus();
});

test('the first ArrowDown selects the first unhighlighted suggestion', async () => {
  const { screen, field } = await mount();
  await userEvent.fill(field.element(), 'i');
  const first = screen.getByRole('option', { name: /^in:/ });
  await expect.element(first).toHaveAttribute('aria-selected', 'false');
  await userEvent.keyboard('{ArrowDown}');
  await expect.element(first).toHaveAttribute('aria-selected', 'true');
});

test('clicking a filter selects its value and keeps the search text', async () => {
  const { screen, field, chips } = await mount();
  await userEvent.fill(field.element(), 'message in:Random ');
  await userEvent.click(screen.getByRole('button', { name: 'Edit in:Random' }));
  await expect.element(field).toHaveValue('message in:Random');
  const input = field.element() as HTMLInputElement;
  expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe('Random');
  await userEvent.keyboard('General ');
  await expect.element(chips).toHaveTextContent('in: General');
  await expect.element(field).toHaveValue('message ');
});

test('editing a date keeps the other filters', async () => {
  const { screen, field, chips } = await mount();
  await userEvent.fill(field.element(), 'in:Random before:2024-01-01 message');
  await userEvent.click(screen.getByRole('button', { name: 'Edit before:2024-01-01' }));
  await expect.element(field).toHaveValue('message before:2024-01-01');
  await userEvent.keyboard('2025-01-01 ');
  await expect.element(chips).toHaveLength(2);
  await expect
    .element(screen.getByRole('button', { name: 'Edit before:2025-01-01' }))
    .toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Edit in:Random' })).toBeVisible();
});

test('editing a quoted filter preserves its negation', async () => {
  const { screen, field } = await mount();
  await userEvent.fill(field.element(), 'has:image -in:"Random" message');
  await userEvent.click(screen.getByRole('button', { name: 'Edit -in:Random' }));
  await expect.element(field).toHaveValue('message -in:"Random"');
  await userEvent.keyboard('General ');
  await expect.element(screen.getByRole('button', { name: 'Edit -in:General' })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Edit has:image' })).toBeVisible();
});

test('a pagination error keeps results visible and retries the failed page', async () => {
  const { screen, field, messages } = await mount();
  messages
    .mockResolvedValueOnce({
      hits: Array.from({ length: 30 }, (_, index) => hit(`$first${index}`)),
      older: null,
    })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ hits: [hit('$next')], older: null });
  await userEvent.fill(field.element(), 'deploy');
  const rows = screen.getByRole('group', { name: /^Open message from/ });
  await expect.element(rows).toHaveLength(30);
  (screen.getByRole('button', { name: en.search.loadMore }).element() as HTMLButtonElement).click();
  await expect.element(screen.getByText(en.search.loadFailed, { exact: true })).toBeVisible();
  await expect.element(rows).toHaveLength(30);
  await userEvent.click(screen.getByRole('button', { name: en.common.tryAgain }));
  await expect.element(rows).toHaveLength(31);
  expect(messages).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30 }));
});

test('indexing updates refresh an unchanged search', async () => {
  const { screen, field, messages, emitCoverage } = await mount();
  messages
    .mockResolvedValueOnce({ hits: [], older: null })
    .mockResolvedValue({ hits: [hit('$indexed')], older: null });
  await userEvent.fill(field.element(), 'deploy');
  await expect.element(screen.getByRole('status')).toHaveTextContent(en.search.empty);
  emitCoverage({ documents: 1, rooms_pending: 0, rooms_failed: 0, state: 'complete' });
  await expect.element(screen.getByRole('group', { name: /^Open message from/ })).toHaveLength(1);
  await expect.element(field).toHaveValue('deploy');
  expect(messages).toHaveBeenCalledTimes(2);
});

test('accepting a suggestion closes the list instead of reopening it', async () => {
  const { screen, field, chips } = await mount();

  await userEvent.fill(field.element(), 'has:im');
  await expect.element(screen.getByRole('listbox')).toBeVisible();

  await userEvent.keyboard('{Enter}');

  await expect.element(chips).toHaveTextContent('has: image');
  await expect.element(field).toHaveValue('');
  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
});

test('clicking a suggestion closes the list', async () => {
  const { screen, field } = await mount();
  await userEvent.fill(field.element(), 'in:Ran');

  await userEvent.click(screen.getByRole('option', { name: /Random/ }).first());

  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
});

test('leaving the field closes the list', async () => {
  const { screen, field } = await mount();
  await userEvent.fill(field.element(), 'has:');
  await expect.element(screen.getByRole('listbox')).toBeVisible();

  field.element().blur();

  await expect.element(screen.getByRole('listbox')).not.toBeInTheDocument();
});

test('a committed filter leaves the input free for the next words', async () => {
  const { field, chips } = await mount();

  await userEvent.fill(field.element(), 'in:Random ');
  await expect.element(chips).toHaveLength(1);
  await expect.element(field).toHaveValue('');

  await userEvent.keyboard('message');

  await expect.element(chips).toHaveLength(1);
  await expect.element(field).toHaveValue('message');
});

test('a space typed after a committed chip is not swallowed', async () => {
  const { field, chips } = await mount();

  await userEvent.fill(field.element(), 'in:Random ');
  await userEvent.keyboard(' ');

  await expect.element(field).toHaveValue(' ');
  await expect.element(chips).toHaveLength(1);
});

test('backspace after that space deletes the space, not the chip', async () => {
  const { field, chips } = await mount();

  await userEvent.fill(field.element(), 'in:Random ');
  await userEvent.keyboard(' {Backspace}');

  await expect.element(chips).toHaveLength(1);
  await expect.element(field).toHaveValue('');
});

test('typing in the middle of the draft keeps the space and the caret', async () => {
  const { field, chips } = await mount();

  await userEvent.fill(field.element(), 'in:Random ');
  await userEvent.keyboard('deploy');
  (field.element() as HTMLInputElement).setSelectionRange(0, 0);
  await userEvent.keyboard(' X');

  await expect.element(field).toHaveValue(' Xdeploy');
  await expect.element(chips).toHaveLength(1);
});

test('a chip is built character by character in front of existing text', async () => {
  const { field, chips } = await mount();

  await userEvent.click(field);
  await userEvent.keyboard('message in:Random');
  await expect.element(chips).not.toBeInTheDocument();

  await userEvent.keyboard(' ');

  await expect.element(chips).toHaveTextContent('in: Random');
  await expect.element(field).toHaveValue('message ');
});

test('a chip names the room rather than its id', async () => {
  const { field, chips } = await mount();

  await userEvent.fill(field.element(), 'message in:!random:example.org ');

  await expect.element(chips).toHaveTextContent('in: Random');
});

test('a negated date bound is reported as unsupported', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'message -before:2024-01-01');

  await expect.element(screen.getByText('Not supported yet: -before')).toBeVisible();
});

test('a negated chip names the negation in its remove button', async () => {
  const { screen, field } = await mount();

  await userEvent.fill(field.element(), 'message -in:Random ');

  await expect.element(screen.getByRole('button', { name: 'Remove -in:Random' })).toBeVisible();
});

test('clicking the field padding focuses the input', async () => {
  const { field } = await mount();

  await userEvent.fill(field.element(), 'in:Random ');
  field.element().blur();
  const padding = document.querySelector<HTMLElement>('.token-field');
  if (!padding) throw new Error('the token field is not rendered');
  await page.elementLocator(padding).click({ position: { x: 2, y: 2 } });

  await expect.element(field).toHaveFocus();
});

test('an empty field lists every operator, even after a chip', async () => {
  const { listbox, field } = await mount();

  await userEvent.fill(field.element(), 'in:Random ');
  field.element().focus();

  await expect.element(listbox.getByRole('option', { name: /^from:/ })).toBeVisible();
  await expect.element(listbox.getByRole('option', { name: /^mentions:/ })).toBeVisible();
});

test('a starter filter begins a filter and offers its values', async () => {
  const { screen, field } = await mount();

  await userEvent.click(screen.getByRole('button', { name: 'in:' }));

  await expect.element(field).toHaveFocus();
  await expect.element(screen.getByRole('listbox')).toBeVisible();
});
