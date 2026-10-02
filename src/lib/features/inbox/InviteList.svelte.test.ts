// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

const rooms = vi.hoisted(() => [] as RoomSummary[]);
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms }),
  roomLabel: (room: RoomSummary) => room.name ?? room.room_id,
}));

import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';

import InviteList from './InviteList.svelte';

Object.assign(core, {
  accountData: vi.fn(() => Promise.resolve(null)),
  setAccountData: vi.fn(() => Promise.resolve()),
});

function invite(roomId: string, name: string): RoomSummary {
  return { room_id: roomId, name, state: 'invited', latest_event: null } as unknown as RoomSummary;
}

afterEach(() => {
  dismissedInvites.stop();
  rooms.length = 0;
});

function names(): string[] {
  return [...document.querySelectorAll('.name-text')].map((node) => node.textContent);
}

function triaged(
  entries: [roomId: string, inviter: string, sharesRoom: boolean, banned?: boolean][]
): void {
  Object.assign(core.commands, {
    inviteTriage: vi.fn(() =>
      Promise.resolve(
        entries.map(([room_id, inviter, shares_room, banned = false]) => ({
          room_id,
          inviter,
          reason: null,
          shares_room,
          inviter_banned: banned,
        }))
      )
    ),
  });
}

function groupTitles(): string[] {
  return screen
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent.replace(/\s+/g, ' ').trim());
}

test('a hidden invite moves behind the hidden toggle and can be restored', async () => {
  rooms.push(invite('!a:example.org', 'Alpha'), invite('!b:example.org', 'Beta'));
  triaged([
    ['!a:example.org', '@friend:example.org', true],
    ['!b:example.org', '@friend:example.org', true],
  ]);
  dismissedInvites.start(core as unknown as CoreClient);
  render(InviteList);
  await vi.waitFor(() => {
    expect(names()).toEqual(['Alpha', 'Beta']);
  });

  await dismissedInvites.dismiss('!a:example.org');
  await vi.waitFor(() => {
    expect(names()).toEqual(['Beta']);
  });

  await userEvent.click(screen.getByRole('button', { name: /^1 hidden/ }));
  expect(names()).toEqual(['Alpha']);
});

test('invites are grouped by sender and accept all only covers people you know', async () => {
  rooms.push(
    invite('!a:example.org', 'Alpha'),
    invite('!b:example.org', 'Beta'),
    invite('!c:example.org', 'Gamma'),
    invite('!d:example.org', 'Delta')
  );
  triaged([
    ['!a:example.org', '@friend:example.org', true],
    ['!b:example.org', '@friend:example.org', true],
    ['!c:example.org', '@stranger:example.org', false],
    ['!d:example.org', '@spammer:example.org', false, true],
  ]);
  const joinRoom = vi.fn((roomId: string) => Promise.resolve(roomId));
  Object.assign(core.commands, { joinRoom });
  dismissedInvites.start(core as unknown as CoreClient);
  render(InviteList);
  await vi.waitFor(() => {
    expect(groupTitles()).toEqual(['From people you know 2', 'From strangers 1', 'Likely spam 1']);
  });
  expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);

  await userEvent.click(screen.getByRole('button', { name: /^Accept all/ }));
  await vi.waitFor(() => {
    expect(joinRoom).toHaveBeenCalledTimes(2);
  });
  expect(joinRoom.mock.calls.map(([roomId]) => roomId)).toEqual([
    '!a:example.org',
    '!b:example.org',
  ]);
});

test('a stranger DM invite shows the inviter id and both badges', async () => {
  rooms.push({ ...invite('!a:example.org', 'Alpha'), is_direct: true });
  triaged([['!a:example.org', '@stranger:elsewhere.org', false]]);
  dismissedInvites.start(core as unknown as CoreClient);
  render(InviteList);
  await vi.waitFor(() => {
    expect(names()).toEqual(['Alpha']);
  });
  expect(screen.getByText('(@stranger:elsewhere.org)')).toBeTruthy();
  expect(screen.getByText('No rooms in common')).toBeTruthy();
  expect(screen.getByText('Direct message')).toBeTruthy();
});

test('an invite from someone you know has neither badge', async () => {
  rooms.push(invite('!a:example.org', 'Alpha'));
  triaged([['!a:example.org', '@friend:example.org', true]]);
  dismissedInvites.start(core as unknown as CoreClient);
  render(InviteList);
  await vi.waitFor(() => {
    expect(names()).toEqual(['Alpha']);
  });
  expect(screen.queryByText('No rooms in common')).toBeNull();
  expect(screen.queryByText('Direct message')).toBeNull();
});
