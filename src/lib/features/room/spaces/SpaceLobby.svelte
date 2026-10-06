<script lang="ts">
  import { CoreError } from '#src/transport';
  import type { RoomPermissionsView, RoomSummary, SpaceChildEdge } from '#src/generated/protocol';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import HashIcon from 'phosphor-svelte/lib/HashIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
  import UsersThreeIcon from 'phosphor-svelte/lib/UsersThreeIcon';
  import { onDestroy, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import { goto } from '$app/navigation';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { createDragList, type DropEdge, type DropInstruction } from '#lib/ui/drag-list.js';
  import { joinErrorMessage } from '#lib/rooms/join-errors.js';
  import { copyRoomLink, roomSectionPath, viaFor } from '#lib/rooms/permalink.js';
  import { roomPathParam, roomPathParamFromId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { layoutSpaceIds, withoutSpace, withSpace } from '#lib/spaces/sidebar-layout.js';
  import { useSpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { longPress, mouseContextMenu } from '#lib/ui/long-press.svelte.js';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import { backToRoomList } from '#lib/features/room/room-navigation.js';

  import {
    applyChildOverrides,
    applySuggestedOverrides,
    buildHierarchySections,
    childEdges,
    edgeSignature,
    levelTargets,
    inAllowList,
    joinCandidates,
    lobbyAction,
    lobbyPhase,
    localHierarchyRooms,
    mergeHierarchyRooms,
    pendingSuggestedOverrides,
    sameLobbyItem,
    type ChildOrderOverride,
    type HierarchyRoom,
    type HierarchyRoomView,
    type HierarchySection,
    type LobbyDragItem,
    type SuggestedOverride,
  } from './space-hierarchy';
  import { dropIndex, reorderChildren, sortEdges, type Reorder } from './space-order';

  import RoomOptionsMenu from '#lib/features/sidebar/RoomOptionsMenu.svelte';
  import { spaceTimelinePath } from '../event-timeline.js';

  import AddExistingDialog from './AddExistingDialog.svelte';
  import FormattedBody from '../messages/FormattedBody.svelte';
  import { splitVia } from '#lib/rooms/join-address.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { topicHtml } from '../topic-html';
  import type { AddExistingKind } from './add-existing';
  import LeaveRoomDialog from '../LeaveRoomDialog.svelte';
  import LobbyRoomPlaceholder from './LobbyRoomPlaceholder.svelte';
  import RoomSettingsDialog from '../settings/RoomSettingsDialog.svelte';
  import SpaceLobbySection from './SpaceLobbySection.svelte';
  import { SpaceHierarchyLoader } from './space-hierarchy-loader.svelte';
  import { JoinQueue } from './join-queue.svelte';

  interface Props {
    space: RoomSummary | null;
  }

  let { space }: Props = $props();
  let optionsAnchor = $state.raw<HTMLElement | CursorAnchor | null>(null);
  let optionsOpen = $state(false);
  let settingsOpen = $state(false);
  let leaveOpen = $state(false);
  const core = useCoreClient();
  const roomList = useRoomList();
  const spaceSidebar = useSpaceSidebar();
  const joining = new SvelteSet<string>();
  const knocked = new SvelteSet<string>();
  const joinErrors = new SvelteMap<string, string>();
  const removed = new SvelteSet<string>();
  const closed = new SvelteSet<string>();
  const visibleLevels = new SvelteSet<string>();

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const hierarchy = new SpaceHierarchyLoader(core);
  let fetched = $derived(hierarchy.fetched);
  let overrides = $state.raw<ChildOrderOverride[]>([]);
  let suggestedOverrides = $state.raw<SuggestedOverride[]>([]);
  let addOpen = $state(false);
  let addKind = $state<AddExistingKind>('rooms');
  let failed = $derived(hierarchy.failed);
  let topicOpen = $state(false);
  let joinAllOn = $state(false);
  const joinQueue = new JoinQueue((roomId, error) => {
    console.warn('[sable lobby] join failed', error);
    joinErrors.set(roomId, joinErrorMessage(error));
  });

  function openTopicLink(link: MatrixLink, anchor: HTMLAnchorElement): void {
    if (link.kind === 'user') return;
    topicOpen = false;
    const { via } = splitVia(anchor.href);
    const target = roomSectionPath(
      roomList.rooms,
      link.roomId,
      link.kind === 'event' ? link.eventId : null,
      via
    );
    void afterOverlayPops().then(() => goto(target));
  }
  let permissionsById = $state.raw(new Map<string, RoomPermissionsView>());
  let permissionsSpace: string | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- request bookkeeping, never rendered from
  const requestedPermissions = new Set<string>();

  let spaceId = $derived(space?.room_id ?? null);
  let canManage = $derived(canManageIn(spaceId));
  let joinedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'joined').map((room) => room.room_id))
  );
  let knockedIds = $derived(
    new Set([
      ...knocked,
      ...roomList.rooms.filter((room) => room.state === 'knocked').map((room) => room.room_id),
    ])
  );
  let invitedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'invited').map((room) => room.room_id))
  );
  let base = $derived.by<HierarchyRoomView[]>(() => {
    if (spaceId === null) return [];
    return mergeHierarchyRooms(localHierarchyRooms(roomList.rooms, spaceId), fetched);
  });
  let ordered = $derived(applyChildOverrides(base, overrides));
  let merged = $derived(applySuggestedOverrides(ordered, suggestedOverrides));
  let sections = $derived.by<HierarchySection[]>(() => {
    if (spaceId === null) return [];
    return buildHierarchySections(
      merged,
      spaceId,
      {
        loaded: hierarchy.loadedLevels,
        failed: hierarchy.failedLevels,
      },
      canManageIn
    )
      .map((section) => ({
        ...section,
        rooms: section.rooms.filter((entry) => !removed.has(entry.key)),
      }))
      .filter(
        (section) =>
          section.rooms.length > 0 ||
          !section.loaded ||
          section.failed ||
          (section.space !== null && canManageIn(section.parentId))
      );
  });
  let moveTargets = $derived(
    merged
      .filter((room) => room.is_space && canManageIn(room.room_id))
      .map((room) => ({
        id: room.room_id,
        name: room.room_id === spaceId ? (space?.name ?? label(room)) : label(room),
      }))
  );
  let candidates = $derived(joinCandidates(sections, joinedIds, invitedIds));
  let pinnedIds = $derived(new Set(layoutSpaceIds(spaceSidebar.items)));
  let phase = $derived(
    lobbyPhase(sections.length, spaceId === null || !hierarchy.loadedLevels.has(spaceId))
  );

  $effect(() => {
    hierarchy.reset(spaceId);
    if (spaceId === null) return;
    joinAllOn = false;
    untrack(() => {
      joinQueue.cancel();
    });
    overrides = [];
    suggestedOverrides = [];
    removed.clear();
    knocked.clear();
    joinErrors.clear();
    closed.clear();
    visibleLevels.clear();
  });

  $effect(() => {
    if (spaceId === null) return;
    hierarchy.enqueue(levelTargets(sections, spaceId, visibleLevels));
  });

  onDestroy(() => {
    hierarchy.dispose();
    joinQueue.cancel();
  });

  $effect(() => {
    if (!joinAllOn) return;
    for (const section of sections) visibleLevels.add(section.key);
    const targets = candidates.map(({ room, via, parentId }) => ({
      roomId: room.room_id,
      run: () => trackedJoin(room, via, parentId),
    }));
    untrack(() => {
      joinQueue.add(targets);
    });
    if (joinQueue.idle && hierarchy.pendingLevels.size === 0) {
      const settled = [...joinQueue.joined].every((id) => joinedIds.has(id));
      if (settled) finishJoinAll();
    }
  });

  function finishJoinAll(): void {
    const failures = joinQueue.failed;
    joinAllOn = false;
    joinQueue.cancel();
    if (failures > 0) toasts.error($i18n.t('room.lobbyJoinAllFailed', { count: failures }));
  }

  function stopJoinAll(): void {
    joinAllOn = false;
    joinQueue.cancel();
  }

  $effect(() => {
    if (overrides.length === 0) return;

    const kept = overrides.filter(
      (override) => edgeSignature(childEdges(base, override.parentId)) === override.baseline
    );
    if (kept.length !== overrides.length) overrides = kept;
  });

  let permissionTargets = $derived(
    merged
      .filter(
        (room) => joinedIds.has(room.room_id) && (room.is_space || boundToParent(room.join_rule))
      )
      .map((room) => room.room_id)
  );

  $effect(() => {
    const targets = permissionTargets;
    const current = spaceId;
    if (current !== permissionsSpace) {
      permissionsSpace = current;
      requestedPermissions.clear();
      permissionsById = new Map();
    }
    for (const roomId of targets) {
      if (requestedPermissions.has(roomId)) continue;
      requestedPermissions.add(roomId);
      void core.commands
        .roomPermissions(roomId)
        .then((next) => {
          if (permissionsSpace !== current) return;
          permissionsById = new Map([...permissionsById, [roomId, next]]);
        })
        .catch((error: unknown) => {
          console.debug('[sable lobby] permissions unavailable', error);
        });
    }
  });

  function canManageIn(roomId: string | null): boolean {
    return roomId !== null && (permissionsById.get(roomId)?.can_manage_children ?? false);
  }

  function boundToParent(joinRule: string | null): boolean {
    return joinRule === 'restricted' || joinRule === 'knock_restricted';
  }

  function canLeaveParent(roomId: string): boolean {
    const room = merged.find((candidate) => candidate.room_id === roomId);
    if (!room || !boundToParent(room.join_rule)) return true;
    return permissionsById.get(roomId)?.can_change_join_rule ?? false;
  }

  function canDropInto(source: LobbyDragItem, parentId: string): boolean {
    if (!canManageIn(parentId)) return false;
    if (source.parentId === parentId || source.roomId === null) return true;
    return canLeaveParent(source.roomId);
  }

  function open(child: HierarchyRoomView): void {
    const target = roomPathParamFromId(child.room_id);
    if (child.is_space) {
      openLobby(child.room_id);
      return;
    }
    if (!space) return;
    void goto(
      resolve('/(app)/space/[spaceId]/[roomId]', {
        spaceId: roomPathParam(space, roomList.rooms),
        roomId: target,
      })
    );
  }

  function openLobby(roomId: string): void {
    void goto(resolve('/(app)/space/[spaceId]/lobby', { spaceId: roomPathParamFromId(roomId) }));
  }

  function createIn(roomId: string, kind: 'create-room' | 'create-space'): void {
    const spaceId = roomPathParamFromId(roomId);
    void goto(
      kind === 'create-room'
        ? resolve('/(app)/space/[spaceId]/create-room', { spaceId })
        : resolve('/(app)/space/[spaceId]/create-space', { spaceId })
    );
  }

  $effect(() => {
    if (suggestedOverrides.length === 0) return;

    const kept = pendingSuggestedOverrides(ordered, suggestedOverrides);
    if (kept.length !== suggestedOverrides.length) suggestedOverrides = kept;
  });

  async function setSuggested(parentId: string, roomId: string, suggested: boolean): Promise<void> {
    const override = { parentId, roomId, suggested };
    const others = (candidate: SuggestedOverride) =>
      candidate.parentId !== parentId || candidate.roomId !== roomId;
    suggestedOverrides = [...suggestedOverrides.filter(others), override];

    try {
      await core.commands.setSpaceChildSuggested(parentId, roomId, suggested);
    } catch (error) {
      console.warn('[sable lobby] suggestion not saved', error);
      suggestedOverrides = suggestedOverrides.filter((candidate) => candidate !== override);
      toasts.error($i18n.t('room.lobbySuggestedFailed'));
    }
  }

  async function addExisting(
    parentId: string,
    roomIds: readonly string[],
    suggested: boolean
  ): Promise<void> {
    let failures = 0;
    for (const roomId of roomIds) {
      try {
        await core.commands.addToSpace(parentId, roomId, suggested);
      } catch (error) {
        failures += 1;
        console.warn('[sable lobby] room not added', error);
      }
    }
    if (failures > 0) toasts.error($i18n.t('room.lobbyAddFailed', { count: failures }));
  }

  function retry(levelId: string): void {
    hierarchy.retry(levelId);
  }

  function togglePin(roomId: string): void {
    const items = spaceSidebar.items;
    spaceSidebar.write(
      pinnedIds.has(roomId) ? withoutSpace(items, roomId) : withSpace(items, roomId)
    );
  }

  async function attemptJoin(
    child: HierarchyRoomView,
    via: readonly string[],
    parentId: string
  ): Promise<boolean> {
    const address = child.canonical_alias ?? child.room_id;
    let routing = viaFor(address, via);
    if (routing.length === 0 && child.canonical_alias === null) {
      routing = await core.commands.roomViaServers(parentId);
    }
    const action = lobbyAction(
      child.join_rule,
      invitedIds.has(child.room_id),
      inAllowList(child, joinedIds, parentId)
    );
    if (action === 'knock') {
      await core.commands.knockRoom(address, routing);
      knocked.add(child.room_id);
      return false;
    }
    try {
      await core.commands.joinRoom(address, routing);
    } catch (error) {
      if (child.join_rule !== 'knock_restricted' || !(error instanceof CoreError)) throw error;
      if (error.detail.code !== 'denied') throw error;
      await core.commands.knockRoom(address, routing);
      knocked.add(child.room_id);
      return false;
    }
    return true;
  }

  async function trackedJoin(
    child: HierarchyRoomView,
    via: readonly string[],
    parentId: string
  ): Promise<boolean> {
    joining.add(child.room_id);
    joinErrors.delete(child.room_id);
    try {
      return await attemptJoin(child, via, parentId);
    } finally {
      joining.delete(child.room_id);
    }
  }

  async function join(
    child: HierarchyRoomView,
    via: readonly string[],
    parentId: string
  ): Promise<void> {
    if (joining.has(child.room_id)) return;
    try {
      await trackedJoin(child, via, parentId);
    } catch (error) {
      console.warn('[sable lobby] join failed', error);
      joinErrors.set(child.room_id, joinErrorMessage(error));
    }
  }

  async function remove(section: HierarchySection, entry: HierarchyRoom): Promise<void> {
    const parentId = section.space?.room_id ?? spaceId;
    if (!parentId) return;

    try {
      await core.commands.removeFromSpace(parentId, entry.room.room_id);
      removed.add(entry.key);
    } catch (error) {
      console.warn('[sable lobby] remove failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  async function removeSubspace(section: HierarchySection): Promise<void> {
    if (section.ownerId === null) return;

    try {
      await core.commands.removeFromSpace(section.ownerId, section.parentId);
    } catch (error) {
      console.warn('[sable lobby] remove failed', error);
      hierarchy.fail();
    }
  }

  async function moveRoom(from: string, roomId: string, target: string): Promise<void> {
    try {
      await core.commands.addToSpace(target, roomId);
    } catch (error) {
      console.warn('[sable lobby] move failed', error);
      hierarchy.fail();
      return;
    }
    try {
      await core.commands.removeFromSpace(from, roomId);
      for (const section of sections) {
        if (section.parentId !== from) continue;
        for (const entry of section.rooms) {
          if (entry.room.room_id === roomId) removed.add(entry.key);
        }
      }
    } catch (error) {
      console.warn('[sable lobby] move left the room in both spaces', error);
      hierarchy.fail();
    }
  }

  const dragList = createDragList<LobbyDragItem>(sameLobbyItem);

  function dropRoom(
    source: LobbyDragItem,
    target: LobbyDragItem,
    instruction: DropInstruction
  ): void {
    if (source.roomId === null || !canDropInto(source, target.parentId)) return;
    if (source.parentId !== target.parentId) {
      void moveRoom(source.parentId, source.roomId, target.parentId);
      return;
    }
    if (target.roomId === null || instruction === 'into') return;
    const section = sections.find((candidate) => candidate.parentId === source.parentId);
    if (section) reorder(section, source.roomId, target.roomId, instruction);
  }

  async function applyReorder(
    parentId: string,
    siblings: readonly SpaceChildEdge[],
    changes: Reorder[]
  ): Promise<void> {
    if (changes.length === 0) return;

    const orders = new Map(changes.map((change) => [change.roomId, change.order]));
    const children = sortEdges(
      siblings.map((edge) =>
        orders.has(edge.room_id) ? { ...edge, order: orders.get(edge.room_id) ?? null } : edge
      )
    );
    overrides = [
      ...overrides.filter((override) => override.parentId !== parentId),
      { parentId, children, baseline: edgeSignature(childEdges(base, parentId)) },
    ];

    try {
      for (const change of changes) {
        await core.commands.setSpaceChildOrder(parentId, change.roomId, change.order);
      }
    } catch (error) {
      console.warn('[sable lobby] reorder failed', error);
      hierarchy.fail();
      overrides = overrides.filter((override) => override.parentId !== parentId);
    }
  }

  function reorderIn(
    parentId: string,
    edges: readonly SpaceChildEdge[],
    source: string,
    target: string,
    position: DropEdge
  ): void {
    const siblings = edges.map((edge) => ({
      roomId: edge.room_id,
      order: edge.order,
    }));
    const from = siblings.findIndex((sibling) => sibling.roomId === source);
    const to = siblings.findIndex((sibling) => sibling.roomId === target);
    if (from === -1 || to === -1) return;

    void applyReorder(
      parentId,
      edges,
      reorderChildren(siblings, source, dropIndex(from, to, position))
    );
  }

  function reorder(
    section: HierarchySection,
    source: string,
    target: string,
    position: DropEdge
  ): void {
    reorderIn(section.parentId, section.siblings, source, target, position);
  }

  function moveSubspace(section: HierarchySection, delta: number): void {
    if (section.ownerId === null) return;

    const edges = childEdges(merged, section.ownerId);
    const spaces = edges.filter(
      (edge) => merged.find((room) => room.room_id === edge.room_id)?.is_space
    );
    const index = spaces.findIndex((edge) => edge.room_id === section.parentId);
    const to = index + delta;
    if (index === -1 || to < 0 || to >= spaces.length) return;

    reorderIn(
      section.ownerId,
      edges,
      section.parentId,
      spaces[to].room_id,
      delta < 0 ? 'above' : 'below'
    );
  }

  function move(section: HierarchySection, roomId: string, delta: number): void {
    const index = section.rooms.findIndex((entry) => entry.room.room_id === roomId);
    const to = index + delta;
    if (index === -1 || to < 0 || to >= section.rooms.length) return;

    const neighbour = section.rooms[to];
    reorder(section, roomId, neighbour.room.room_id, delta < 0 ? 'above' : 'below');
  }

  function toggle(key: string): void {
    if (closed.has(key)) closed.delete(key);
    else closed.add(key);
  }

  function label(child: HierarchyRoomView): string {
    return child.name ?? child.canonical_alias ?? child.room_id;
  }

  function openOptions(anchor: HTMLElement | CursorAnchor | null): void {
    if (anchor === null) return;
    optionsAnchor = anchor;
    optionsOpen = true;
  }
</script>

<section class="lobby" aria-label={$i18n.t('nav.lobby')}>
  <header
    class="hero"
    role="presentation"
    oncontextmenu={mouseContextMenu((event) => {
      if (!space) return;
      event.preventDefault();
      openOptions(cursorAnchor(event));
    })}
    {@attach longPress({
      enabled: () => space !== null,
      onPress: (event) => {
        openOptions(cursorAnchor(event));
      },
    })}
  >
    {#if !appLayout.matches}
      <div class="mobile-back-menu">
        <IconButton
          variant="ghost"
          size="small"
          label={$i18n.t('timeline.back')}
          onclick={backToRoomList}
        >
          <BackIcon />
        </IconButton>
      </div>
    {/if}
    {#if space}
      <div class="hero-menu">
        {#if preferences.developerTools}
          <Tooltip label={$i18n.t('room.menuShowSpaceTimeline')} side="bottom">
            {#snippet trigger({ props })}
              <IconButton
                {...props}
                variant="ghost"
                size="small"
                label={$i18n.t('room.menuShowSpaceTimeline')}
                onclick={() => {
                  void goto(spaceTimelinePath(space, roomList.rooms));
                }}
              >
                <ListBulletsIcon />
              </IconButton>
            {/snippet}
          </Tooltip>
        {/if}
        <IconButton
          variant="ghost"
          size="small"
          label={$i18n.t('room.menuLabel')}
          onclick={(event) => {
            openOptions(event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
          }}
        >
          <DotsThreeVerticalIcon />
        </IconButton>
      </div>
    {/if}
    <Avatar
      id={spaceId}
      src={space?.avatar_url ?? null}
      name={space?.name ?? ''}
      size="large"
      uniform
    />
    <h1>{space?.name ?? $i18n.t('nav.space')}</h1>
    {#if space?.topic}
      <button
        type="button"
        class="topic"
        onclick={() => {
          topicOpen = true;
        }}
      >
        <span class="topic-text">{space.topic}</span>
      </button>
    {/if}
    {#if canManage && space}
      {@const managed = space}
      <div class="hero-actions">
        <ActionMenu label={$i18n.t('room.lobbyAdd')}>
          {#snippet trigger({ props })}
            <Button {...props} variant="primary" size="small" class="hero-action">
              <PlusIcon />
              {$i18n.t('room.lobbyAdd')}
            </Button>
          {/snippet}
          <IconContext values={{ 'aria-hidden': 'true', size: 16 }}>
            <ActionMenuItem
              onSelect={() => {
                void goto(
                  resolve('/(app)/space/[spaceId]/create-room', {
                    spaceId: roomPathParam(managed, roomList.rooms),
                  })
                );
              }}
            >
              <PlusIcon />{$i18n.t('nav.createRoomInSpace')}
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => {
                void goto(
                  resolve('/(app)/space/[spaceId]/create-space', {
                    spaceId: roomPathParam(managed, roomList.rooms),
                  })
                );
              }}
            >
              <UsersThreeIcon />{$i18n.t('nav.createSubspace')}
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => {
                addKind = 'rooms';
                addOpen = true;
              }}
            >
              <HashIcon />{$i18n.t('room.lobbyAddExistingRooms')}
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => {
                addKind = 'spaces';
                addOpen = true;
              }}
            >
              <SquaresFourIcon />{$i18n.t('room.lobbyAddExistingSpaces')}
            </ActionMenuItem>
          </IconContext>
        </ActionMenu>
      </div>
      {#if addOpen}
        <AddExistingDialog
          bind:open={addOpen}
          space={managed}
          kind={addKind}
          onAdd={(roomIds, suggested) => {
            void addExisting(managed.room_id, roomIds, suggested);
          }}
        />
      {/if}
    {/if}
    {#if joinAllOn}
      <div class="join-all" role="status">
        <Spinner small />
        <span>
          {$i18n.t(joinQueue.waiting ? 'room.lobbyJoinWaiting' : 'room.lobbyJoinProgress', {
            done: joinQueue.done,
            total: joinQueue.total,
          })}
        </span>
        <Button variant="ghost" size="small" onclick={stopJoinAll}
          >{$i18n.t('room.lobbyJoinStop')}</Button
        >
      </div>
    {:else if candidates.length > 0}
      <div class="hero-actions">
        <Button
          variant="secondary"
          size="small"
          class="hero-action"
          onclick={() => {
            joinAllOn = true;
          }}
        >
          <PlusIcon />
          {$i18n.t('room.lobbyJoinAll', { count: candidates.length })}
        </Button>
      </div>
    {/if}
  </header>

  {#if failed}
    <Alert variant="critical" role="alert">
      <p>{$i18n.t('room.lobbyFailed')}</p>
      {#if spaceId}
        {@const target = spaceId}
        <div>
          <Button
            variant="secondary"
            size="small"
            onclick={() => {
              retry(target);
            }}>{$i18n.t('room.lobbyRetry')}</Button
          >
        </div>
      {/if}
    </Alert>
  {/if}

  {#if phase === 'loading'}
    <div class="placeholder" role="status" aria-label={$i18n.t('room.lobbyLoading')}>
      <LobbyRoomPlaceholder rows={3} />
    </div>
  {:else if phase === 'empty'}
    {#if canManage}
      <EmptyState title={$i18n.t('room.lobbyEmpty')} description={$i18n.t('room.lobbyEmptyManage')}>
        {#snippet actions()}
          <Button
            onclick={() => {
              addKind = 'rooms';
              addOpen = true;
            }}>{$i18n.t('room.lobbyAddRooms')}</Button
          >
        {/snippet}
      </EmptyState>
    {:else}
      <p class="empty">{$i18n.t('room.lobbyEmpty')}</p>
    {/if}
  {:else}
    {#each sections as section (section.key)}
      <SpaceLobbySection
        {section}
        closed={closed.has(section.key)}
        {joinedIds}
        {invitedIds}
        {joining}
        knocked={knockedIds}
        {joinErrors}
        canManage={canManageIn(section.parentId)}
        canManageOwner={canManageIn(section.ownerId)}
        {canLeaveParent}
        {canDropInto}
        {label}
        onToggle={toggle}
        onVisible={(key) => visibleLevels.add(key)}
        onOpen={open}
        onJoin={(child: HierarchyRoomView, via: readonly string[], parentId: string) => {
          void join(child, via, parentId);
        }}
        onCopyLink={(child: HierarchyRoomView) => {
          void copyRoomLink(core, child);
        }}
        onRemove={(section: HierarchySection, entry: HierarchyRoom) => {
          void remove(section, entry);
        }}
        {dragList}
        onDropRoom={dropRoom}
        onMove={move}
        {moveTargets}
        pinned={section.space !== null && pinnedIds.has(section.space.room_id)}
        joinedSpace={section.space !== null && joinedIds.has(section.space.room_id)}
        onOpenLobby={openLobby}
        onCreateIn={createIn}
        onTogglePin={togglePin}
        onRetry={retry}
        onSetSuggested={(parentId: string, roomId: string, suggested: boolean) => {
          void setSuggested(parentId, roomId, suggested);
        }}
        onMoveSubspace={moveSubspace}
        onRemoveSubspace={(section: HierarchySection) => {
          void removeSubspace(section);
        }}
        onMoveTo={(section: HierarchySection, entry: HierarchyRoom, target: string) => {
          void moveRoom(section.parentId, entry.room.room_id, target);
        }}
      />
    {/each}

    {#if hierarchy.pendingLevels.size > 0}
      <p class="loading-note" role="status">
        <Spinner small />
        <span>{$i18n.t('room.lobbyLoadingMore')}</span>
      </p>
    {/if}
  {/if}
</section>

<DialogFrame bind:open={topicOpen} variant="verification" label={$i18n.t('room.lobbyTopicTitle')}>
  <div class="topic-dialog">
    <h2>{space?.name ?? $i18n.t('nav.space')}</h2>
    <div class="topic-full">
      <FormattedBody html={topicHtml(space?.topic ?? '')} onMatrixLink={openTopicLink} />
    </div>
    <DialogActions>
      <Button
        variant="ghost"
        onclick={() => {
          topicOpen = false;
        }}>{$i18n.t('room.lobbyTopicClose')}</Button
      >
    </DialogActions>
  </div>
</DialogFrame>

{#if space}
  {#if optionsAnchor}
    <RoomOptionsMenu
      room={space}
      anchor={optionsAnchor}
      bind:open={optionsOpen}
      onSettings={() => {
        settingsOpen = true;
      }}
      onLeave={() => {
        leaveOpen = true;
      }}
    />
  {/if}

  {#if settingsOpen}
    <RoomSettingsDialog
      open
      room={space}
      onOpenChange={(next) => {
        settingsOpen = next;
      }}
    />
  {/if}

  {#if leaveOpen}
    <LeaveRoomDialog
      open
      room={space}
      onOpenChange={(next) => {
        leaveOpen = next;
      }}
    />
  {/if}
{/if}

<style>
  .lobby {
    display: grid;
    gap: var(--space-400);
  }

  .hero {
    display: grid;
    justify-items: center;
    padding: var(--space-500) 0 var(--space-100);
    position: relative;
    text-align: center;
    -webkit-touch-callout: none;
    user-select: none;
  }

  .mobile-back-menu {
    left: 0;
    position: absolute;
    top: var(--space-300);
  }

  .hero-menu {
    position: absolute;
    right: 0;
    top: var(--space-300);
  }

  .join-all {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    justify-content: center;
    margin-top: var(--space-300);
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    justify-content: center;
    margin-top: var(--space-300);
  }

  :global(.hero-action) {
    border-radius: var(--radius-pill);
  }

  :global(.hero-action-subspace) {
    --button-container: var(--surface-var-container);
    --button-container-active: var(--surface-var-container-active);
    --button-container-hover: var(--surface-var-container-hover);
    --button-line: var(--surface-var-container-line);
    --button-on-container: var(--surface-var-on-container);
  }

  h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: var(--space-300) 0 0;
  }

  .topic {
    background: none;
    border: 0;
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: block;
    font: inherit;
    margin: var(--space-200) 0 0;
    max-width: 48ch;
    padding: 0;
    text-align: center;
  }

  .topic-text {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    white-space: pre-wrap;
  }

  .topic:hover {
    text-decoration: underline;
  }

  .topic:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .topic-dialog {
    display: grid;
    gap: var(--space-300);
    width: min(32rem, calc(100vw - 2rem));
  }

  .topic-dialog h2 {
    font-size: var(--font-size-heading);
    line-height: 1.3;
    margin: 0;
  }

  .topic-full {
    color: var(--surface-var-on-container);
    line-height: 1.45;
    margin: 0;
    max-height: 60dvh;
    overflow: auto;
    overflow-wrap: break-word;
  }

  .loading-note {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    margin: 0;
  }

  .placeholder {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    color: var(--bg-on-container);
    overflow: hidden;
  }

  .empty {
    color: var(--surface-var-on-container);
    margin: 0;
  }
</style>
