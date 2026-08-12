<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import { findRoomByPathId, roomPathParam, useRoomList } from '$lib/rooms/room-list.svelte';
  import type { RoomSummary } from '@/generated/RoomSummary';
  import { SvelteSet } from 'svelte/reactivity';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import CompassIcon from 'phosphor-svelte/lib/CompassIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  interface Props {
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
  }

  let { onNavigate, width, collapsed = false }: Props = $props();
  const roomList = useRoomList();

  type RoomNavRow = {
    room?: RoomSummary;
    roomId: string;
    parentSpaceId?: string;
    depth: number;
    kind: 'room';
    key: string;
  };

  type RoomNavCategory = {
    children: RoomNavItem[];
    depth: number;
    kind: 'category';
    key: string;
    room: RoomSummary;
  };

  type RoomNavItem = RoomNavCategory | RoomNavRow;

  const closedCategories = new SvelteSet<string>();
  let roomsClosed = $state(false);

  let title = $derived.by(() => {
    const { pathname } = page.url;

    if (pathname.startsWith('/direct')) return $i18n.t('nav.direct');
    if (pathname.startsWith('/space')) return $i18n.t('nav.space');

    return $i18n.t('nav.home');
  });
  let TitleIcon = $derived(page.url.pathname.startsWith('/direct') ? ChatsIcon : HouseIcon);
  let spaceRootItems = $derived.by<RoomNavItem[]>(() => {
    if (!page.url.pathname.startsWith('/space')) return [];

    const space = findRoomByPathId(roomList.rooms, page.params.spaceId);
    if (!space?.is_space) return [];

    const roomsById = new Map(roomList.rooms.map((room) => [room.room_id, room]));
    return spaceItems(space, roomsById, [space.room_id], space.room_id);
  });
  let rooms = $derived.by<RoomNavRow[]>(() => {
    if (page.url.pathname.startsWith('/direct')) {
      return roomList.rooms
        .filter((room) => room.is_direct)
        .map((room) => ({ room, roomId: room.room_id, depth: 0, kind: 'room', key: room.room_id }));
    }

    if (page.url.pathname.startsWith('/space')) {
      return spaceRootItems.filter(isRoom);
    }

    return roomList.rooms
      .filter((room) => !room.is_space && !room.is_direct && room.space_parents.length === 0)
      .map((room) => ({ room, roomId: room.room_id, depth: 0, kind: 'room', key: room.room_id }));
  });
  let subspaces = $derived.by(() => spaceRootItems.filter((item) => item.kind === 'category'));
  let visibleSubspaces = $derived.by<RoomNavItem[]>(() => visibleItems(subspaces));
  let visibleRooms = $derived.by<RoomNavItem[]>(() => [
    ...(roomsClosed ? [] : rooms),
    ...visibleSubspaces,
  ]);

  function spaceItems(
    space: RoomSummary,
    roomsById: Map<string, RoomSummary>,
    ancestry: string[],
    rootSpaceId: string,
    depth = 0
  ): RoomNavItem[] {
    const items: RoomNavItem[] = [];

    for (const child of space.space_children) {
      const room = roomsById.get(child.room_id);
      if (!room || room.is_space) continue;

      items.push({
        room,
        roomId: child.room_id,
        parentSpaceId: rootSpaceId,
        depth,
        kind: 'room',
        key: [...ancestry, child.room_id].join('/'),
      });
    }

    for (const child of space.space_children) {
      const room = roomsById.get(child.room_id);
      if (!room?.is_space) continue;

      items.push({
        room,
        depth,
        kind: 'category',
        key: [...ancestry, child.room_id].join('/'),
        children: ancestry.includes(room.room_id)
          ? []
          : spaceItems(room, roomsById, [...ancestry, room.room_id], rootSpaceId),
      });
    }

    return items;
  }

  function roomName(room: RoomSummary) {
    return room.name ?? room.room_id;
  }

  function roomHref(row: RoomNavRow) {
    const routeId = row.room ? roomPathParam(row.room) : row.roomId;
    if (page.url.pathname.startsWith('/direct')) {
      return resolve('/(app)/direct/[roomId]', { roomId: routeId });
    }

    if (row.parentSpaceId) {
      const parentSpace = findRoomByPathId(roomList.rooms, row.parentSpaceId);
      return resolve('/(app)/space/[spaceId]/[roomId]', {
        spaceId: parentSpace ? roomPathParam(parentSpace) : row.parentSpaceId,
        roomId: routeId,
      });
    }

    return resolve('/(app)/home/[roomId]', { roomId: routeId });
  }

  function initial(name: string) {
    return name.slice(0, 1).toUpperCase();
  }

  function toggleCategory(key: string) {
    if (closedCategories.has(key)) closedCategories.delete(key);
    else closedCategories.add(key);
  }

  function visibleItems(items: RoomNavItem[]): RoomNavItem[] {
    const visible: RoomNavItem[] = [];

    for (const item of items) {
      visible.push(item);
      if (item.kind === 'category' && !closedCategories.has(item.key)) {
        visible.push(...visibleItems(item.children));
      }
    }

    return visible;
  }

  function isRoom(item: RoomNavItem): item is RoomNavRow {
    return item.kind === 'room';
  }
</script>

<section
  class="room-nav"
  aria-label={$i18n.t('nav.rooms')}
  style:--room-nav-width={width === undefined ? undefined : String(width) + 'px'}
>
  <header class="room-nav-header" class:collapsed>
    <h2 aria-label={collapsed ? title : undefined}>
      {#if collapsed}
        <span aria-hidden="true"><TitleIcon /></span>
      {:else}
        {title}
      {/if}
    </h2>
    <button class="overflow-button" type="button" aria-label={$i18n.t('nav.moreOptions')}>
      <span aria-hidden="true"><DotsThreeIcon /></span>
    </button>
  </header>

  <div class="room-nav-content">
    <div class="room-nav-actions" class:collapsed>
      <a
        href={resolve('/create-room')}
        onclick={() => onNavigate?.('/create-room')}
        aria-label={collapsed ? $i18n.t('nav.createRoom') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><PlusIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.createRoom')}</span>{/if}
      </a>
      <button
        type="button"
        disabled
        aria-label={collapsed ? $i18n.t('nav.joinWithAddress') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><LinkIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.joinWithAddress')}</span>{/if}
      </button>
      <a
        href={resolve('/explore')}
        onclick={() => onNavigate?.('/explore')}
        aria-label={collapsed ? $i18n.t('nav.exploreSpaces') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><CompassIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.exploreSpaces')}</span>{/if}
      </a>
      <button
        type="button"
        disabled
        aria-label={collapsed ? $i18n.t('nav.messageSearch') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><MagnifyingGlassIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.messageSearch')}</span>{/if}
      </button>
    </div>

    {#if !collapsed}
      <button
        type="button"
        class="rooms-heading"
        aria-expanded={!roomsClosed}
        onclick={() => {
          roomsClosed = !roomsClosed;
        }}
      >
        <span class:closed={roomsClosed} class="category-caret" aria-hidden="true"
          ><CaretDownIcon /></span
        >
        <span class="rooms-heading-label">{$i18n.t('nav.rooms')}</span>
      </button>
    {/if}

    {#if rooms.length === 0 && subspaces.length === 0}
      {#if !collapsed && !roomsClosed}
        <div class="empty-rooms">
          <p>{$i18n.t('nav.roomsUnavailable')}</p>
        </div>
      {/if}
    {:else}
      <div class="room-list" class:collapsed>
        {#each visibleRooms as item (item.key)}
          {#if item.kind === 'category'}
            {@const name = roomName(item.room)}
            {@const isClosed = closedCategories.has(item.key)}
            <button
              type="button"
              class="room-category"
              class:collapsed
              style:--room-depth={collapsed ? 0 : item.depth}
              aria-label={collapsed ? `${name} (${$i18n.t('nav.space')})` : undefined}
              aria-expanded={!isClosed}
              onclick={() => {
                toggleCategory(item.key);
              }}
            >
              <span class:closed={isClosed} class="category-caret" aria-hidden="true"
                ><CaretDownIcon /></span
              >
              {#if !collapsed}<span class="category-name">{name}</span>{/if}
            </button>
          {:else if isRoom(item)}
            {@const room = item.room}
            {@const name = room ? roomName(room) : item.roomId}
            {@const href = roomHref(item)}
            {@const unread = room?.highlight || room?.unread || 0}
            <a
              class="room-row"
              class:active={page.url.pathname === href}
              {href}
              style:--room-depth={collapsed ? 0 : item.depth}
              onclick={() => onNavigate?.(href)}
              aria-label={collapsed ? name : undefined}
              aria-current={page.url.pathname === href ? 'page' : undefined}
            >
              <span class="room-icon" aria-hidden="true">{initial(name)}</span>
              {#if !collapsed}
                <span class="room-name">{name}</span>
                {#if unread > 0}
                  <span
                    class:highlight={(room?.highlight ?? 0) > 0}
                    class="room-badge"
                    aria-label={$i18n.t('nav.unreadMessages', { count: unread })}>{unread}</span
                  >
                {/if}
              {/if}
            </a>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .room-nav {
    background: var(--sable-bg-container);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .room-nav-header {
    align-items: center;
    display: flex;
    flex: 0 0 2.875rem;
    justify-content: space-between;
    min-height: 2.875rem;
    padding: 0 0.75rem 0 1rem;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overflow-button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    height: 2rem;
    justify-content: center;
    width: 2rem;
  }

  .overflow-button:hover,
  .overflow-button:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .room-nav-actions {
    display: grid;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem 0.5rem;
  }

  .room-nav-actions :is(a, button) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: 0.5rem;
    height: 2rem;
    padding: 0 0.5rem;
    text-align: left;
    text-decoration: none;
  }

  .room-nav-actions :is(a, button):not(:disabled):hover,
  .room-nav-actions :is(a, button):not(:disabled):focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .room-nav-actions button:disabled {
    cursor: default;
    opacity: 1;
  }

  .room-nav-header.collapsed {
    justify-content: center;
    padding: 0;
  }

  .room-nav-header.collapsed h2 {
    display: flex;
  }

  .room-nav-header.collapsed .overflow-button {
    display: none;
  }

  .room-nav-actions.collapsed {
    justify-items: center;
    padding: 0.25rem 0;
  }

  .room-nav-actions.collapsed :is(a, button) {
    justify-content: center;
    padding: 0;
    width: 2rem;
  }

  .room-nav-actions :global(svg),
  .rooms-heading :global(svg),
  .overflow-button :global(svg) {
    flex: 0 0 auto;
    height: 1rem;
    width: 1rem;
  }

  .room-nav-content {
    flex: 1;
    min-height: 0;
    overflow: hidden auto;
  }

  .rooms-heading {
    align-items: center;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 0.25rem;
    padding: 0.75rem 1rem 0.5rem;
    text-align: left;
    width: 100%;
  }

  .rooms-heading:hover,
  .rooms-heading:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .rooms-heading-label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.06em;
    margin: 0;
    text-transform: uppercase;
  }

  .empty-rooms {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    padding: 0.5rem 1rem;
  }

  .room-list {
    display: grid;
    gap: 0.125rem;
    min-width: 0;
    padding: 0 0.5rem 0.5rem;
  }

  .room-row {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    gap: 0.5rem;
    min-height: 2.25rem;
    min-width: 0;
    padding: 0 0.5rem 0 calc(0.5rem + var(--room-depth) * 1rem);
    text-decoration: none;
  }

  .room-row:hover,
  .room-row:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .room-row.active {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .room-icon {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: flex;
    flex: 0 0 1.5rem;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 1.5rem;
    justify-content: center;
    width: 1.5rem;
  }

  .room-category {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    gap: 0.25rem;
    min-height: 2rem;
    padding: 0 0.5rem 0 calc(0.5rem + var(--room-depth) * 1rem);
    text-align: left;
    text-transform: uppercase;
    width: 100%;
  }

  .room-category:hover,
  .room-category:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .category-caret {
    display: flex;
  }

  .category-caret.closed {
    transform: rotate(-90deg);
  }

  .category-caret :global(svg) {
    height: 0.875rem;
    width: 0.875rem;
  }

  .category-name,
  .room-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .category-name {
    flex: 1;
  }

  .room-name {
    flex: 1;
  }

  .room-badge {
    background: var(--sable-surface-var-container);
    border-radius: 999px;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    margin-left: auto;
    min-width: 1.25rem;
    padding: 0.125rem 0.375rem;
    text-align: center;
  }

  .room-badge.highlight {
    background: var(--sable-primary-main);
    color: var(--sable-primary-on-container);
  }

  .room-list.collapsed {
    justify-items: center;
    padding: 0 0 0.5rem;
  }

  .room-list.collapsed .room-row {
    justify-content: center;
    padding: 0;
    width: 2rem;
  }

  .room-list.collapsed .room-category {
    justify-content: center;
    margin: 0 auto;
    padding: 0;
    width: 2rem;
  }

  :is(
    .overflow-button,
    .room-nav-actions :is(a, button),
    .room-category,
    .rooms-heading
  ):focus-visible {
    outline: 3px solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  @media (width >= 48rem) {
    .room-nav {
      flex: 0 0 var(--room-nav-width);
      width: var(--room-nav-width);
    }
  }
</style>
