<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';
  import { SvelteSet } from 'svelte/reactivity';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParam, roomPathParamFromId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';

  import {
    buildHierarchySections,
    lobbyAction,
    type HierarchyRoom,
    type HierarchySection,
  } from './space-hierarchy';
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

  $effect(() => {
    const target = spaceId;
    if (!target) return;

    let current = true;
    rooms = [];
    nextBatch = null;
    failed = false;
    loading = true;
    removed.clear();
    knocked.clear();
    closed.clear();

    void core
      .spaceHierarchy(target)
      .then((page) => {
        if (!current) return;
        rooms = page.rooms;
        nextBatch = page.nextBatch;
      })
      .catch((error: unknown) => {
        console.warn('[sable lobby] hierarchy unavailable', error);
        if (current) failed = true;
      })
      .finally(() => {
        if (current) loading = false;
      });

    return () => {
      current = false;
    };
  });

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
    const batch = nextBatch;
    if (!target || batch === null || loading) return;

    loading = true;
    try {
      const page = await core.spaceHierarchy(target, batch);
      if (spaceId !== target) return;
      rooms = [...rooms, ...page.rooms];
      nextBatch = page.nextBatch;
    } catch (error) {
      if (spaceId !== target) return;
      console.warn('[sable lobby] further pages unavailable', error);
      failed = true;
    } finally {
      if (spaceId === target) loading = false;
    }
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

  async function copyLink(child: SpaceHierarchyRoomView): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        `https://matrix.to/#/${child.canonical_alias ?? child.room_id}`
      );
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

  {#if loading && sections.length === 0}
    <div class="category">
      <ul class="rooms">
        {#each [0, 1, 2] as placeholder (placeholder)}
          <li class="room">
            <Skeleton class="room-avatar-skeleton" />
            <div class="room-text">
              <Skeleton style="height: 1rem; width: 30%" />
              <Skeleton style="height: 0.8125rem; width: 60%" />
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {:else if sections.length === 0 && !failed}
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
      />
    {/each}

    {#if nextBatch !== null}
      <div class="more">
        <Button {loading} onclick={loadMore}>{$i18n.t('room.lobbyMore')}</Button>
      </div>
    {/if}
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

  .empty {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .more {
    display: flex;
    justify-content: center;
  }
</style>
