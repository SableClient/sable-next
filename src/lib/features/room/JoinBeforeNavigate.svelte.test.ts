// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomPreviewView } from '#src/generated/protocol';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  roomPreview: vi.fn<() => Promise<RoomPreviewView>>(),
  knockRoom: vi.fn<(address: string, via: string[], reason?: string) => Promise<string>>(),
  leaveRoom: vi.fn<(roomId: string) => Promise<void>>(),
});

import JoinBeforeNavigate from './JoinBeforeNavigate.svelte';

function preview(overrides: Partial<RoomPreviewView> = {}): RoomPreviewView {
  return {
    room_id: '!room:example.org',
    canonical_alias: null,
    name: 'Knock room',
    topic: null,
    avatar_url: null,
    is_space: false,
    is_voice: false,
    num_joined_members: 3,
    join_rule: 'knock',
    state: null,
    ...overrides,
  };
}

afterEach(() => {
  core.roomPreview.mockReset();
  core.knockRoom.mockReset();
  core.leaveRoom.mockReset();
});

test('sends the optional message with the request to join', async () => {
  const user = userEvent.setup();
  core.roomPreview.mockResolvedValue(preview());
  core.knockRoom.mockResolvedValue('!room:example.org');
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  await user.type(
    await screen.findByLabelText('Message for the moderators (optional)'),
    '  a friend of Ana  '
  );
  await user.click(screen.getByRole('button', { name: 'Ask to join' }));

  expect(core.knockRoom).toHaveBeenCalledWith('!room:example.org', [], 'a friend of Ana');
  expect(screen.getByRole('status')).toHaveTextContent('Your request to join has been sent.');
});

test('a blank message sends no reason', async () => {
  const user = userEvent.setup();
  core.roomPreview.mockResolvedValue(preview());
  core.knockRoom.mockResolvedValue('!room:example.org');
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  await user.click(await screen.findByRole('button', { name: 'Ask to join' }));

  expect(core.knockRoom).toHaveBeenCalledWith('!room:example.org', [], undefined);
});

test('a pending request can be withdrawn', async () => {
  const user = userEvent.setup();
  core.roomPreview.mockResolvedValue(preview({ state: 'knocked' }));
  core.leaveRoom.mockResolvedValue();
  render(JoinBeforeNavigate, { roomId: '!room:example.org' });

  await user.click(await screen.findByRole('button', { name: 'Withdraw request' }));

  expect(core.leaveRoom).toHaveBeenCalledWith('!room:example.org');
  expect(screen.getByRole('button', { name: 'Ask to join' })).toBeInTheDocument();
});
