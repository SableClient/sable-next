// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { RoomJoinRuleView } from '#src/generated/protocol';

import type { HierarchyRoomView, HierarchySection } from './space-hierarchy';
import SpaceLobbySection from './SpaceLobbySection.svelte';

function subspace(joinRule: RoomJoinRuleView): HierarchyRoomView {
  return {
    room_id: '!sub:example.org',
    canonical_alias: null,
    name: 'Sub',
    topic: null,
    avatar_url: null,
    is_space: true,
    is_voice: false,
    num_joined_members: 3,
    join_rule: joinRule,
    guest_can_join: false,
    children: [],
  };
}

function mount(joinRule: RoomJoinRuleView, joinedIds: string[]) {
  const onJoin = vi.fn();
  const section: HierarchySection = {
    space: subspace(joinRule),
    suggested: false,
    depth: 1,
    key: '!sub:example.org',
    rooms: [],
    parentId: '!sub:example.org',
    ownerId: '!root:example.org',
    siblings: [],
    loaded: true,
    failed: false,
    pending: 0,
  };
  const noop = vi.fn();
  render(SpaceLobbySection, {
    section,
    closed: true,
    joinedIds: new Set(joinedIds),
    invitedIds: new Set<string>(),
    joining: new Set<string>(),
    knocked: new Set<string>(),
    joinErrors: new Map<string, string>(),
    canManage: false,
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
    '!root:example.org'
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
