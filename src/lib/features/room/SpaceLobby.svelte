<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';
  import { SvelteSet } from 'svelte/reactivity';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import type { DropEdge } from '#lib/ui/drag-list.js';
  import { matrixToUrl } from '#lib/rooms/permalink.js';
  import { roomPathParam, roomPathParamFromId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import {
    buildHierarchySections,
    lobbyAction,
    lobbyPhase,
    type HierarchyRoom,
    type HierarchySection,
  } from './space-hierarchy';
  import { dropIndex, reorderChildren, sortEdges, type Reorder } from './space-order';
  import { initials } from './timeline-format';
  import SpaceLobbySection from './SpaceLobbySection.svelte';

  interface Props {
    space: RoomSummary | null;
  }

  let { space }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const joining = new SvelteSet<string>();
  const knocked = new SvelteSet<string>();
  const removed = new SvelteSet<string>();
  const closed = new SvelteSet<string>();

  let rooms = $state.raw<SpaceHierarchyRoomView[]>([]);
  let nextBatch = $state<string | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let permissions = $state<RoomPermissionsView | null>(null);

  const MAX_HIERARCHY_PAGES = 20;

  let resume = { cancelled: false };

  let spaceId = $derived(space?.room_id ?? null);
  let canManage = $derived(permissions?.can_manage_children ?? false);
  let joinedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'joined').map((room) => room.room_id))
  );
  let invitedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'invited').map((room) => room.room_id))
  );
  let sections = $derived.by<HierarchySection[]>(() => {
    if (spaceId === null) return [];
    return buildHierarchySections(rooms, spaceId)
      .map((section) => ({
        ...section,
        rooms: section.rooms.filter((entry) => !removed.has(entry.key)),
      }))
      .filter((section) => section.rooms.length > 0);
  });
  let phase = $derived(lobbyPhase(sections.length, loading, nextBatch !== null && !failed));

  $effect(() => {
    const target = spaceId;
    if (!target) return;

    resume.cancelled = true;
    const load = { cancelled: false };
    resume = load;
    rooms = [];
    nextBatch = null;
    failed = false;
    removed.clear();
    knocked.clear();
    closed.clear();

    void loadAllPages(target, load);

    return () => {
      load.cancelled = true;
    };
  });

  async function loadAllPages(
    target: string,
    load: { cancelled: boolean },
    startFrom: string | null = null,
    known: readonly SpaceHierarchyRoomView[] = []
  ): Promise<void> {
    let from: string | null = startFrom;
    let collected: SpaceHierarchyRoomView[] = [...known];
    loading = true;

    for (let page = 0; page < MAX_HIERARCHY_PAGES; page += 1) {
      try {
        const next = await core.spaceHierarchy(target, from);
        if (load.cancelled) return;

        collected = [...collected, ...next.rooms];
        rooms = collected;
        nextBatch = next.nextBatch;
        failed = false;
        from = next.nextBatch;
      } catch (error) {
        if (load.cancelled) return;
        console.warn('[sable lobby] hierarchy unavailable', error);
        failed = true;
        break;
      }

      if (from === null) break;
    }

    if (!load.cancelled) loading = false;
  }

  $effect(() => {
    const target = spaceId;
    if (!target) return;

    let current = true;
    permissions = null;
    void core
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

  async function loadMore(): Promise<void> {
    const target = spaceId;
    if (!target || nextBatch === null || loading) return;

    resume = { cancelled: false };
    await loadAllPages(target, resume, nextBatch, rooms);
  }

  function open(child: SpaceHierarchyRoomView): void {
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

  async function join(child: SpaceHierarchyRoomView): Promise<void> {
    if (joining.has(child.room_id)) return;
    joining.add(child.room_id);
    try {
      // The alias is likelier to resolve for a room our server has not seen.
      const address = child.canonical_alias ?? child.room_id;
      if (lobbyAction(child.join_rule, invitedIds.has(child.room_id)) === 'knock') {
        await core.knockRoom(address);
        knocked.add(child.room_id);
        return;
      }
      await core.joinRoom(address);
      open(child);
    } catch (error) {
      console.warn('[sable lobby] join failed', error);
    } finally {
      joining.delete(child.room_id);
    }
  }

  /** The section's own space owns the edge, so it is what the removal targets. */
  async function remove(section: HierarchySection, entry: HierarchyRoom): Promise<void> {
    const parentId = section.space?.room_id ?? spaceId;
    if (!parentId) return;

    try {
      await core.removeFromSpace(parentId, entry.room.room_id);
      removed.add(entry.key);
    } catch (error) {
      console.warn('[sable lobby] remove failed', error);
    }
  }

  async function applyReorder(section: HierarchySection, changes: Reorder[]): Promise<void> {
    if (changes.length === 0) return;

    const orders = new Map(changes.map((change) => [change.roomId, change.order]));
    rooms = rooms.map((room) =>
      room.room_id === section.parentId
        ? {
            ...room,
            children: sortEdges(
              room.children.map((edge) =>
                orders.has(edge.room_id)
                  ? { ...edge, order: orders.get(edge.room_id) ?? null }
                  : edge
              )
            ),
          }
        : room
    );

    try {
      for (const change of changes) {
        await core.setSpaceChildOrder(section.parentId, change.roomId, change.order);
      }
    } catch (error) {
      console.warn('[sable lobby] reorder failed', error);
      failed = true;
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

  async function copyLink(child: SpaceHierarchyRoomView): Promise<void> {
    try {
      const via = child.canonical_alias ? [] : await core.roomViaServers(child.room_id);
      await navigator.clipboard.writeText(matrixToUrl(child.canonical_alias ?? child.room_id, via));
    } catch (error) {
      console.debug('[sable lobby] clipboard unavailable', error);
    }
  }

  function toggle(key: string): void {
    if (closed.has(key)) closed.delete(key);
    else closed.add(key);
  }

  function label(child: SpaceHierarchyRoomView): string {
    return child.name ?? child.canonical_alias ?? child.room_id;
  }
</script>

<section class="lobby" aria-label={$i18n.t('nav.lobby')}>
  <header class="hero">
    <Avatar src={space?.avatar_url ?? null} initials={initials(space?.name ?? '')} size="large" />
    <h1>{space?.name ?? $i18n.t('nav.space')}</h1>
    {#if space?.topic}<p class="topic">{space.topic}</p>{/if}
  </header>

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.lobbyFailed')}</Alert>
  {/if}

  {#if phase === 'loading'}
    <p class="loading-note" role="status">
      <Spinner />
      <span>{$i18n.t('room.lobbyLoading')}</span>
    </p>
    <div class="category">
      <ul class="rooms">
        {#each [0, 1, 2] as placeholder (placeholder)}
          <li class="room">
            <Skeleton class="room-avatar-skeleton" />
            <div class="room-text">
              <Skeleton style="height: 1rem; width: 30%" />
              <Skeleton style="height: var(--font-size-small); width: 60%" />
            </div>
          </li>
        {/each}
      </ul>
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
        {canManage}
        {label}
        onToggle={toggle}
        onOpen={open}
        onJoin={(child: SpaceHierarchyRoomView) => {
          void join(child);
        }}
        onCopyLink={(child: SpaceHierarchyRoomView) => {
          void copyLink(child);
        }}
        onRemove={(section: HierarchySection, entry: HierarchyRoom) => {
          void remove(section, entry);
        }}
        onReorder={reorder}
        onMove={move}
      />
    {/each}
  {/if}

  {#if loading && sections.length > 0}
    <p class="loading-note" role="status">
      <Spinner small />
      <span>{$i18n.t('room.lobbyLoadingMore')}</span>
    </p>
  {/if}

  {#if nextBatch !== null}
    <div class="more">
      <Button {loading} onclick={loadMore}>{$i18n.t('room.lobbyMore')}</Button>
    </div>
  {/if}
</section>

<style>
  .lobby {
    display: grid;
    gap: var(--space-3);
  }

  .hero {
    display: grid;
    justify-items: center;
    padding: var(--space-4) 0 var(--space-2);
    text-align: center;
  }

  h1 {
    font-size: var(--font-size-xlarge);
    line-height: var(--line-height-heading);
    margin: var(--space-2) 0 0;
  }

  .topic {
    color: var(--sable-surface-var-on-container);
    margin: var(--space-1) 0 0;
    max-width: 48ch;
  }

  .loading-note {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-tight);
    margin: 0;
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .more {
    display: flex;
    justify-content: center;
  }
</style>
