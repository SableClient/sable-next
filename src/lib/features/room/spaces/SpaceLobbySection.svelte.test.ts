// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { RoomJoinRuleView } from '#src/generated/protocol';

import { buildHierarchySections, type HierarchyRoomView } from './space-hierarchy';
import { sectionProps, space } from './lobby-section-fixtures';
import SpaceLobbySection from './SpaceLobbySection.svelte';

function mount(
  joinRule: RoomJoinRuleView,
  joinedIds: string[],
  rights: { canManage?: boolean; canManageOwner?: boolean } = {},
  room: HierarchyRoomView | null = null
) {
  const onJoin = vi.fn();
  const onTopic = vi.fn();
  const rooms = [
    space('!root:example.org', 'public', room ? [room.room_id] : ['!sub:example.org']),
    room ?? space('!sub:example.org', joinRule, []),
  ];
  const [section] = buildHierarchySections(rooms, '!root:example.org', {
    joined: joinedIds,
    keepEmpty: ['!sub:example.org'],
  });
  render(
    SpaceLobbySection,
    sectionProps(section, joinedIds, {
      ...rights,
      closed: room === null,
      onTopic,
      onJoin,
      joinedSpace: joinedIds.includes('!sub:example.org'),
    })
  );
  return { onJoin, onTopic, user: userEvent.setup() };
}

test('a room topic opens its full description', async () => {
  const room = {
    ...space('!room:example.org', 'public', []),
    is_space: false,
    name: 'Room',
    topic: 'A long description',
  };
  const { onJoin, onTopic, user } = mount('public', ['!root:example.org'], {}, room);

  await user.click(screen.getByRole('button', { name: 'A long description' }));

  expect(onTopic).toHaveBeenCalledWith(expect.objectContaining({ room_id: '!room:example.org' }));
  expect(onJoin).not.toHaveBeenCalled();
});

test.each([false, true])('only a public child can be managed (private: %s)', async (isPrivate) => {
  const root = space('!root:example.org', 'public', ['!chat']);
  root.children = [{ ...root.children[0], private: isPrivate }];
  const chat = { ...space('!chat', 'invite', []), is_space: false, name: 'Chat' };
  const joined = ['!root:example.org', '!chat'];
  const [section] = buildHierarchySections([root, chat], '!root:example.org', {
    joined,
    keepEmpty: [],
  });
  render(SpaceLobbySection, sectionProps(section, joined, { canManage: true, closed: false }));

  const triggers = screen.getAllByRole('button', { name: 'Room options' });
  await userEvent.setup().click(triggers[triggers.length - 1]);
  await screen.findAllByRole('menuitem');

  for (const name of ['Move up', 'Remove']) {
    expect(screen.queryByRole('menuitem', { name }) === null).toBe(isPrivate);
  }
});

test('a subspace members of its parent can join offers a join', async () => {
  const { onJoin, user } = mount('restricted', ['!root:example.org']);

  await user.click(screen.getByRole('button', { name: 'Join' }));

  expect(onJoin).toHaveBeenCalledWith(
    expect.objectContaining({ room_id: '!sub:example.org' }),
    [],
    '!root:example.org',
    'join'
  );
});

test('a subspace that takes knocks asks to join from outside its parent', () => {
  mount('knock_restricted', []);

  expect(screen.getByRole('button', { name: 'Ask to join' })).toBeInTheDocument();
});

test('a joined subspace offers no join', () => {
  mount('public', ['!root:example.org', '!sub:example.org']);

  expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
});

test.each([
  [{ canManage: true }, true, false],
  [{ canManageOwner: true }, false, true],
])(
  'a subspace header offers what its own and its parent space let you change (%o)',
  async (rights, creates, arranges) => {
    const { user } = mount('public', ['!root:example.org', '!sub:example.org'], rights);

    await user.click(screen.getByRole('button', { name: 'Room options' }));

    expect(
      (await screen.findAllByRole('menuitem')).some((item) =>
        item.textContent.includes('Create room in space')
      )
    ).toBe(creates);
    expect(screen.queryByRole('menuitem', { name: 'Move up' }) !== null).toBe(arranges);
  }
);
