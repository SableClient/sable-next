import { vi } from 'vitest';
import type { ComponentProps } from 'svelte';

import type { RoomJoinRuleView } from '#src/generated/protocol';

import type { HierarchyRoomView, HierarchySection } from './space-hierarchy';
import type SpaceLobbySection from './SpaceLobbySection.svelte';

export function space(
  roomId: string,
  joinRule: RoomJoinRuleView,
  children: string[],
  name = 'Sub'
): HierarchyRoomView {
  return {
    room_id: roomId,
    canonical_alias: null,
    name,
    topic: null,
    avatar_url: null,
    is_space: true,
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
      private: false,
    })),
  };
}

export function sectionProps(
  section: HierarchySection,
  joinedIds: string[],
  overrides: Partial<ComponentProps<typeof SpaceLobbySection>> = {}
): ComponentProps<typeof SpaceLobbySection> {
  const noop = vi.fn();
  return {
    section,
    closed: false,
    joinedIds: new Set(joinedIds),
    joining: new Set<string>(),
    knocked: new Set<string>(),
    joinErrors: new Map<string, string>(),
    canManage: false,
    canManageOwner: false,
    canLeaveParent: () => true,
    canDropInto: () => true,
    label: (child: HierarchyRoomView) => child.name ?? child.room_id,
    onToggle: noop,
    onVisible: noop,
    onOpen: noop,
    onTopic: noop,
    onJoin: noop,
    onCopyLink: noop,
    onRemove: noop,
    dragList: { draggable: () => undefined, dropTarget: () => undefined } as never,
    onDropRoom: noop,
    onMove: noop,
    moveTargets: [],
    pinned: false,
    joinedSpace: false,
    onOpenLobby: noop,
    onCreateIn: noop,
    onTogglePin: noop,
    onSetSuggested: noop,
    onRetry: noop,
    onMoveSubspace: noop,
    onRemoveSubspace: noop,
    onMoveTo: noop,
    ...overrides,
  };
}
