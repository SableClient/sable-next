<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import type { DropEdge } from '#lib/ui/drag-list.js';
  import { joinErrorMessage } from '#lib/rooms/join-errors.js';
  import { matrixToUrl } from '#lib/rooms/permalink.js';
  import { roomPathParam, roomPathParamFromId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import {
    applyChildOverrides,
    buildHierarchySections,
    childEdges,
    edgeSignature,
    levelTargets,
    lobbyAction,
    lobbyPhase,
    localHierarchyRooms,
    mergeHierarchyRooms,
    type ChildOrderOverride,
    type HierarchyRoom,
    type HierarchyRoomView,
    type HierarchySection,
  } from './space-hierarchy';
  import { dropIndex, reorderChildren, sortEdges, type Reorder } from './space-order';

  import LobbyRoomPlaceholder from './LobbyRoomPlaceholder.svelte';
  import SpaceLobbySection from './SpaceLobbySection.svelte';

  interface Props {
    space: RoomSummary | null;
  }

  let { space }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const joining = new SvelteSet<string>();
  const knocked = new SvelteSet<string>();
  const joinErrors = new SvelteMap<string, string>();
  const removed = new SvelteSet<string>();
  const closed = new SvelteSet<string>();
  const loadedLevels = new SvelteSet<string>();
  const pendingLevels = new SvelteSet<string>();
  const failedLevels = new SvelteSet<string>();

  let fetched = $state.raw<SpaceHierarchyRoomView[]>([]);
  let overrides = $state.raw<ChildOrderOverride[]>([]);
  let failed = $state(false);
  let topicOpen = $state(false);
  let permissions = $state<RoomPermissionsView | null>(null);

  const MAX_LEVEL_PAGES = 10;

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the enqueue effect probes it, and a reactive set would make that effect invalidate itself on every level it starts
  let requested = new Set<string>();
  let queue: string[] = [];
  let drainingFor: number | null = null;
  let generation = 0;

  let spaceId = $derived(space?.room_id ?? null);
  let canManage = $derived(permissions?.can_manage_children ?? false);
  let joinedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'joined').map((room) => room.room_id))
  );
  let invitedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'invited').map((room) => room.room_id))
  );
  let base = $derived.by<HierarchyRoomView[]>(() => {
    if (spaceId === null) return [];
    return mergeHierarchyRooms(localHierarchyRooms(roomList.rooms, spaceId), fetched);
  });
  let merged = $derived(applyChildOverrides(base, overrides));
  let sections = $derived.by<HierarchySection[]>(() => {
    if (spaceId === null) return [];
    return buildHierarchySections(merged, spaceId, {
      loaded: loadedLevels,
      failed: failedLevels,
    })
      .map((section) => ({
        ...section,
        rooms: section.rooms.filter((entry) => !removed.has(entry.key)),
      }))
      .filter((section) => section.rooms.length > 0 || !section.loaded || section.failed);
  });
  let phase = $derived(lobbyPhase(sections.length, spaceId === null || !loadedLevels.has(spaceId)));

  $effect(() => {
    const target = spaceId;
    if (!target) return;

    generation += 1;
    requested = new Set();
    queue = [];
    drainingFor = null;
    fetched = [];
    overrides = [];
    failed = false;
    loadedLevels.clear();
    pendingLevels.clear();
    failedLevels.clear();
    removed.clear();
    knocked.clear();
    joinErrors.clear();
    closed.clear();
  });

  $effect(() => {
    const target = spaceId;
    if (target === null) return;

    const mine = generation;
    for (const levelId of levelTargets(sections, target, closed)) {
      if (requested.has(levelId)) continue;

      requested.add(levelId);
      queue.push(levelId);
      pendingLevels.add(levelId);
    }

    if (queue.length > 0 && drainingFor !== mine) {
      drainingFor = mine;
      void drain(mine);
    }
  });

  async function drain(mine: number): Promise<void> {
    try {
      while (mine === generation) {
        const target = queue.shift();
        if (target === undefined) return;
        await loadLevel(target, mine);
      }
    } finally {
      if (drainingFor === mine) drainingFor = null;
    }
  }

  async function loadLevel(target: string, mine: number): Promise<void> {
    let from: string | null = null;

    for (let page = 0; page < MAX_LEVEL_PAGES; page += 1) {
      try {
        const next = await core.commands.spaceHierarchy(target, from);
        if (mine !== generation) return;

        fetched = [...fetched, ...next.rooms];
        from = next.nextBatch;
      } catch (error) {
        if (mine !== generation) return;
        console.warn('[sable lobby] hierarchy unavailable', target, error);
        if (target === spaceId) failed = true;
        else failedLevels.add(target);
        break;
      }

      if (from === null) break;
    }

    if (from !== null) console.warn('[sable lobby] level truncated', target);
    if (mine !== generation) return;
    pendingLevels.delete(target);
    loadedLevels.add(target);
  }

  $effect(() => {
    if (overrides.length === 0) return;

    const kept = overrides.filter(
      (override) => edgeSignature(childEdges(base, override.parentId)) === override.baseline
    );
    if (kept.length !== overrides.length) overrides = kept;
  });

  $effect(() => {
    const target = spaceId;
    if (!target) return;

    let current = true;
    permissions = null;
    void core.commands
      .roomPermissions(target)
      .then((next) => {
        if (current) permissions = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable lobby] permissions unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  function open(child: HierarchyRoomView): void {
    const target = roomPathParamFromId(child.room_id);
    if (child.is_space) {
      void goto(resolve('/(app)/space/[spaceId]', { spaceId: target }));
      return;
    }
    if (!space) return;
    void goto(
      resolve('/(app)/space/[spaceId]/[roomId]', {
        spaceId: roomPathParam(space),
        roomId: target,
      })
    );
  }

  async function join(child: HierarchyRoomView): Promise<void> {
    if (joining.has(child.room_id)) return;
    joining.add(child.room_id);
    joinErrors.delete(child.room_id);
    try {
      const address = child.canonical_alias ?? child.room_id;
      if (lobbyAction(child.join_rule, invitedIds.has(child.room_id)) === 'knock') {
        await core.commands.knockRoom(address);
        knocked.add(child.room_id);
        return;
      }
      await core.commands.joinRoom(address);
      open(child);
    } catch (error) {
      console.warn('[sable lobby] join failed', error);
      joinErrors.set(child.room_id, joinErrorMessage(error));
    } finally {
      joining.delete(child.room_id);
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
    }
  }

  async function applyReorder(section: HierarchySection, changes: Reorder[]): Promise<void> {
    if (changes.length === 0) return;

    const parentId = section.parentId;
    const orders = new Map(changes.map((change) => [change.roomId, change.order]));
    const children = sortEdges(
      section.siblings.map((edge) =>
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
      failed = true;
      overrides = overrides.filter((override) => override.parentId !== parentId);
    }
  }

  function reorder(
    section: HierarchySection,
    source: string,
    target: string,
    position: DropEdge
  ): void {
    const siblings = section.siblings.map((edge) => ({
      roomId: edge.room_id,
      order: edge.order,
    }));
    const from = siblings.findIndex((sibling) => sibling.roomId === source);
    const to = siblings.findIndex((sibling) => sibling.roomId === target);
    if (from === -1 || to === -1) return;

    void applyReorder(section, reorderChildren(siblings, source, dropIndex(from, to, position)));
  }

  function move(section: HierarchySection, roomId: string, delta: number): void {
    const index = section.rooms.findIndex((entry) => entry.room.room_id === roomId);
    const to = index + delta;
    if (index === -1 || to < 0 || to >= section.rooms.length) return;

    const neighbour = section.rooms[to];
    reorder(section, roomId, neighbour.room.room_id, delta < 0 ? 'above' : 'below');
  }

  async function copyLink(child: HierarchyRoomView): Promise<void> {
    try {
      const via = child.canonical_alias ? [] : await core.commands.roomViaServers(child.room_id);
      await navigator.clipboard.writeText(matrixToUrl(child.canonical_alias ?? child.room_id, via));
    } catch (error) {
      console.debug('[sable lobby] clipboard unavailable', error);
    }
  }

  function toggle(key: string): void {
    if (closed.has(key)) closed.delete(key);
    else closed.add(key);
  }

  function label(child: HierarchyRoomView): string {
    return child.name ?? child.canonical_alias ?? child.room_id;
  }
</script>

<section class="lobby" aria-label={$i18n.t('nav.lobby')}>
  <header class="hero">
    <Avatar src={space?.avatar_url ?? null} name={space?.name ?? ''} size="large" />
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
  </header>

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.lobbyFailed')}</Alert>
  {/if}

  {#if phase === 'loading'}
    <p class="loading-note" role="status">
      <Spinner />
      <span>{$i18n.t('room.lobbyLoading')}</span>
    </p>
    <div class="placeholder">
      <LobbyRoomPlaceholder rows={3} />
    </div>
  {:else if phase === 'empty'}
    <p class="empty">{$i18n.t('room.lobbyEmpty')}</p>
  {:else}
    {#each sections as section (section.key)}
      <SpaceLobbySection
        {section}
        closed={closed.has(section.key)}
        {joinedIds}
        {invitedIds}
        {joining}
        {knocked}
        {joinErrors}
        {canManage}
        {label}
        onToggle={toggle}
        onOpen={open}
        onJoin={(child: HierarchyRoomView) => {
          void join(child);
        }}
        onCopyLink={(child: HierarchyRoomView) => {
          void copyLink(child);
        }}
        onRemove={(section: HierarchySection, entry: HierarchyRoom) => {
          void remove(section, entry);
        }}
        onReorder={reorder}
        onMove={move}
      />
    {/each}

    {#if pendingLevels.size > 0}
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
    <p class="topic-full">{space?.topic}</p>
    <div class="topic-actions">
      <Button
        variant="ghost"
        onclick={() => {
          topicOpen = false;
        }}>{$i18n.t('room.lobbyTopicClose')}</Button
      >
    </div>
  </div>
</DialogFrame>

<style>
  .lobby {
    display: grid;
    gap: var(--space-400);
  }

  .hero {
    display: grid;
    justify-items: center;
    padding: var(--space-500) 0 var(--space-300);
    text-align: center;
  }

  h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: var(--space-300) 0 0;
  }

  .topic {
    background: none;
    border: 0;
    color: var(--sable-surface-var-on-container);
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
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
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
    color: var(--sable-surface-var-on-container);
    line-height: 1.45;
    margin: 0;
    max-height: 60dvh;
    overflow: auto;
    overflow-wrap: break-word;
    white-space: pre-wrap;
  }

  .topic-actions {
    display: flex;
    justify-content: flex-end;
  }

  .loading-note {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    margin: 0;
  }

  .placeholder {
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }
</style>
