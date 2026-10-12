// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { RoomJoinRuleView } from '#src/generated/protocol';

import { buildHierarchySections, type HierarchyRoomView } from './space-hierarchy';
import SpaceLobbySection from './SpaceLobbySection.svelte';

function space(roomId: string, joinRule: RoomJoinRuleView, children: string[]): HierarchyRoomView {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: 'Sub',
    topic: null,
    avatar_url: null,
    is_space: true,
    is_voice: false,
    num_joined_members: 3,
    join_rule: joinRule,
    allowed_room_ids: [],
    guest_can_join: false,
    children: children.map((child) => ({
      room_id: child,
      via: [],
      order: null,
      origin_server_ts: 0,
      suggested: false,
    })),
  };
}

function mount(
  joinRule: RoomJoinRuleView,
  joinedIds: string[],
  rights: { canManage?: boolean; canManageOwner?: boolean } = {}
) {
  const onJoin = vi.fn();
  const [section] = buildHierarchySections(
    [
      space('!root:example.org', 'public', ['!sub:example.org']),
      space('!sub:example.org', joinRule, []),
    ],
    '!root:example.org',
    { joined: joinedIds, keepEmpty: ['!sub:example.org'] }
  );
  const noop = vi.fn();
  render(SpaceLobbySection, {
    section,
    closed: true,
    joinedIds: new Set(joinedIds),
    joining: new Set<string>(),
    knocked: new Set<string>(),
    joinErrors: new Map<string, string>(),
    canManage: rights.canManage ?? false,
    canManageOwner: rights.canManageOwner ?? false,
    canLeaveParent: () => true,
    canDropInto: () => true,
    label: (child: HierarchyRoomView) => child.name ?? child.room_id,
    onToggle: noop,
    onVisible: noop,
    onOpen: noop,
    onJoin,
    onCopyLink: noop,
    onRemove: noop,
    dragList: { draggable: () => undefined, dropTarget: () => undefined } as never,
    onDropRoom: noop,
    onMove: noop,
    moveTargets: [],
    pinned: false,
    joinedSpace: joinedIds.includes('!sub:example.org'),
    onOpenLobby: noop,
    onCreateIn: noop,
    onTogglePin: noop,
    onSetSuggested: noop,
    onRetry: noop,
    onMoveSubspace: noop,
    onRemoveSubspace: noop,
    onMoveTo: noop,
  });
  return { onJoin, user: userEvent.setup() };
}

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
