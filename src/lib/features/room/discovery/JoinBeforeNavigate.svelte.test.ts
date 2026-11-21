// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomPreviewView } from '#src/generated/protocol';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [], roomSpaces: () => undefined }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = baseCore;
Object.assign(core.rpc.rooms, {
  preview: vi.fn<() => Promise<RoomPreviewView>>(),
  knock:
    vi.fn<(params: { address: string; via: string[]; reason: string | null }) => Promise<string>>(),
  leave: vi.fn<(params: { room_id: string }) => Promise<null>>(),
});

import JoinBeforeNavigate from './JoinBeforeNavigate.svelte';

function preview(overrides: Partial<RoomPreviewView> = {}): RoomPreviewView {
  return {
    room_id: '!room:example.org',
    canonical_alias: null,
    name: 'Knock room',
    topic: null,
    topic_html: null,
    avatar_url: null,
    room_kind: 'text',
    num_joined_members: 3,
    join_rule: 'knock',
    state: null,
    via: { type: 'unknown' },
    ...overrides,
  };
}

afterEach(() => {
  core.rpc.rooms.preview.mockReset();
  core.rpc.rooms.knock.mockReset();
  core.rpc.rooms.leave.mockReset();
});

test('sends the optional message with the request to join', async () => {
  const user = userEvent.setup();
  core.rpc.rooms.preview.mockResolvedValue(preview());
  core.rpc.rooms.knock.mockResolvedValue('!room:example.org');
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  await user.type(await screen.findByRole('textbox'), '  a friend of Ana  ');
  await user.click(within(screen.getByRole('main')).getByRole('button'));

  expect(core.rpc.rooms.knock).toHaveBeenCalledWith({
    address: '!room:example.org',
    via: [],
    reason: 'a friend of Ana',
  });
  expect(screen.getByRole('status')).toBeInTheDocument();
});

test('a topic shows its rich text over the plain fallback', async () => {
  core.rpc.rooms.preview.mockResolvedValue(
    preview({ topic: '**Rules** apply', topic_html: '<strong>Rules</strong> apply' })
  );
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  expect((await screen.findByText('Rules')).tagName).toBe('STRONG');
  expect(screen.queryByText(/\*\*Rules\*\*/)).not.toBeInTheDocument();
});

test('a plain topic is not read as markdown', async () => {
  core.rpc.rooms.preview.mockResolvedValue(preview({ topic: '**Rules** apply' }));
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  expect(await screen.findByText(/apply/)).toBeInTheDocument();
  expect(document.querySelector('.join-topic strong')).toBeNull();
});

test('a blank message sends no reason', async () => {
  const user = userEvent.setup();
  core.rpc.rooms.preview.mockResolvedValue(preview());
  core.rpc.rooms.knock.mockResolvedValue('!room:example.org');
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  await user.click(await within(await screen.findByRole('main')).findByRole('button'));

  expect(core.rpc.rooms.knock).toHaveBeenCalledWith({
    address: '!room:example.org',
    via: [],
    reason: null,
  });
});

test('a pending request can be withdrawn', async () => {
  const user = userEvent.setup();
  core.rpc.rooms.preview.mockResolvedValue(preview());
  core.rpc.rooms.leave.mockResolvedValue(null);
  render(JoinBeforeNavigate, {
    roomId: '!room:example.org',
    membership: 'knocked',
  });

  await user.click(await within(await screen.findByRole('main')).findByRole('button'));

  expect(core.rpc.rooms.leave).toHaveBeenCalledWith({
    room_id: '!room:example.org',
  });
  const main = within(screen.getByRole('main'));
  expect(main.getByRole('textbox')).toBeInTheDocument();
  expect(main.getByRole('button')).toBeInTheDocument();
});

test('an invitation offers to join even when the room is knock-only', async () => {
  core.rpc.rooms.preview.mockResolvedValue(preview());
  render(JoinBeforeNavigate, {
    roomId: '!room:example.org',
    membership: 'invited',
  });

  expect(await screen.findByText('Knock room')).toBeInTheDocument();
  expect(document.querySelector('.join-invite')).not.toBeNull();
  expect(within(screen.getByRole('main')).getByRole('button')).toBeInTheDocument();
  expect(document.querySelector('.knock')).toBeNull();
});

test('a banned account is told so and offered no action', async () => {
  core.rpc.rooms.preview.mockResolvedValue(preview({ join_rule: 'public' }));
  render(JoinBeforeNavigate, {
    roomId: '!room:example.org',
    membership: 'banned',
  });

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(within(screen.getByRole('main')).queryByRole('button')).toBeNull();
});

test('the member count is hidden when the server did not give one', async () => {
  core.rpc.rooms.preview.mockResolvedValue(preview({ num_joined_members: null }));
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  await screen.findByRole('heading', { name: 'Knock room' });
  expect(document.querySelector('.join-members')).toBeNull();
});

test('a preview from a remote server names it, and one from this client names nothing', async () => {
  core.rpc.rooms.preview.mockResolvedValue(
    preview({ via: { type: 'remote', server: 'other.example' } })
  );
  const { unmount } = render(JoinBeforeNavigate, {
    roomId: '!room:example.org',
  });
  await screen.findByRole('heading', { name: 'Knock room' });
  expect(document.querySelector('.provenance')?.textContent).toContain('other.example');
  unmount();

  core.rpc.rooms.preview.mockResolvedValue(preview({ via: { type: 'client' } }));
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });
  await screen.findByRole('heading', { name: 'Knock room' });
  expect(document.querySelector('.provenance')).toBeNull();
});
