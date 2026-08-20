<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import {
    findRoomByPathId,
    roomPathParam,
    roomPathParamFromId,
    useRoomList,
  } from '#lib/rooms/room-list.svelte.js';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { SvelteSet } from 'svelte/reactivity';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import CompassIcon from 'phosphor-svelte/lib/CompassIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import FlagIcon from 'phosphor-svelte/lib/FlagIcon';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import LeaveRoomDialog from '#lib/features/room/LeaveRoomDialog.svelte';
  import RoomSettingsDialog from '#lib/features/room/RoomSettingsDialog.svelte';

  import RoomInvites from './RoomInvites.svelte';
  import RoomOptionsMenu from './RoomOptionsMenu.svelte';

  interface Props {
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
  }

  let { onNavigate, width, collapsed = false }: Props = $props();
  const roomList = useRoomList();
  const core = useCoreClient();
  let settingsRoomId = $state<string | null>(null);
  let leaveRoomId = $state<string | null>(null);
  let spacePermissions = $state<RoomPermissionsView | null>(null);

  let directSection = $derived(page.url.pathname.startsWith('/direct'));

  let activeSpace = $derived(
    page.url.pathname.startsWith('/space')
      ? (findRoomByPathId(roomList.rooms, page.params.spaceId) ?? null)
      : null
  );

  // The id, not the summary: a room list diff hands back a fresh object for the
  // same space, and the permission effect below would re-run on every one.
  let activeSpaceId = $derived(activeSpace?.room_id ?? null);
  // Outside a space anyone may create a room; inside one it also has to land as
  // a child, which the space's own power levels govern.
  let canCreateHere = $derived(
    activeSpace === null || (spacePermissions?.can_manage_children ?? false)
  );
  // Nested under the space so its rail, room list and header survive the
  // navigation; the flat routes would drop back to Home.
  let createRoomHref = $derived(
    activeSpace === null
      ? resolve('create-room')
      : resolve('/(app)/space/[spaceId]/create-room', { spaceId: roomPathParam(activeSpace) })
  );

  // A space browses its own children through the lobby; the public directory is
  // a home-level destination.
  let browseHref = $derived(
    activeSpace === null
      ? resolve('explore')
      : resolve('/(app)/space/[spaceId]/lobby', { spaceId: roomPathParam(activeSpace) })
  );

  let browseLabel = $derived(
    activeSpace === null ? $i18n.t('nav.exploreSpaces') : $i18n.t('nav.lobby')
  );

  let createRoomLabel = $derived(
    activeSpace === null ? $i18n.t('nav.createRoom') : $i18n.t('nav.createRoomInSpace')
  );

  // Held by id so the dialogs follow the live summary.
  let settingsRoom = $derived(
    roomList.rooms.find((room) => room.room_id === settingsRoomId) ?? null
  );
  let leaveRoom = $derived(roomList.rooms.find((room) => room.room_id === leaveRoomId) ?? null);

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
  const roomListId = $props.id();
  let roomsClosed = $state(false);

  const newChatHref = resolve('direct');
  let listLabel = $derived(directSection ? $i18n.t('nav.chats') : $i18n.t('nav.rooms'));
  let listEmpty = $derived(
    directSection ? $i18n.t('nav.chatsEmpty') : $i18n.t('nav.roomsUnavailable')
  );

  let title = $derived.by(() => {
    const { pathname } = page.url;

    if (directSection) return $i18n.t('nav.direct');
    if (pathname.startsWith('/space')) {
      const space = findRoomByPathId(roomList.rooms, page.params.spaceId);
      return space?.name ?? $i18n.t('nav.space');
    }

    return $i18n.t('nav.home');
  });
  let TitleIcon = $derived(directSection ? ChatsIcon : HouseIcon);
  let spaceRootItems = $derived.by<RoomNavItem[]>(() => {
    if (!page.url.pathname.startsWith('/space')) return [];

    const space = findRoomByPathId(roomList.rooms, page.params.spaceId);
    if (!space?.is_space) return [];

    const roomsById = new Map(
      roomList.rooms.filter((room) => room.state === 'joined').map((room) => [room.room_id, room])
    );
    return spaceItems(space, roomsById, [space.room_id], space.room_id);
  });
  let rooms = $derived.by<RoomNavRow[]>(() => {
    if (directSection) {
      return roomList.rooms
        .filter((room) => room.state === 'joined' && room.is_direct)
        .map((room) => ({ room, roomId: room.room_id, depth: 0, kind: 'room', key: room.room_id }));
    }

    if (page.url.pathname.startsWith('/space')) {
      return spaceRootItems.filter(isRoom);
    }

    const claimedByJoinedSpace = new Set(
      roomList.rooms
        .filter((space) => space.is_space && space.state === 'joined')
        .flatMap((space) => space.space_children.map((child) => child.room_id))
    );

    return roomList.rooms
      .filter(
        (room) =>
          room.state === 'joined' &&
          !room.is_space &&
          !room.is_direct &&
          !claimedByJoinedSpace.has(room.room_id)
      )
      .map((room) => ({ room, roomId: room.room_id, depth: 0, kind: 'room', key: room.room_id }));
  });
  let subspaces = $derived(spaceRootItems.filter((item) => item.kind === 'category'));
  let visibleSubspaces = $derived<RoomNavItem[]>(visibleItems(subspaces));
  let visibleRooms = $derived<RoomNavItem[]>([...(roomsClosed ? [] : rooms), ...visibleSubspaces]);

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
    const routeId = row.room ? roomPathParam(row.room) : roomPathParamFromId(row.roomId);
    if (directSection) {
      return resolve('/(app)/direct/[roomId]', { roomId: routeId });
    }

    if (row.parentSpaceId) {
      const parentSpace = findRoomByPathId(roomList.rooms, row.parentSpaceId);
      return resolve('/(app)/space/[spaceId]/[roomId]', {
        spaceId: parentSpace ? roomPathParam(parentSpace) : roomPathParamFromId(row.parentSpaceId),
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

  // Adding a room to a space writes `m.space.child` there, so the space's own
  // power levels decide whether creating from inside it is offered at all.
  $effect(() => {
    const spaceId = activeSpaceId;
    if (!spaceId) {
      spacePermissions = null;
      return;
    }

    let current = true;
    spacePermissions = null;
    void core
      .roomPermissions(spaceId)
      .then((next) => {
        if (current) spacePermissions = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable nav] space permissions unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  function openSettings(room: RoomSummary): void {
    settingsRoomId = room.room_id;
  }

  function openLeave(room: RoomSummary): void {
    leaveRoomId = room.room_id;
  }
</script>

<section
  class="room-nav"
  aria-label={listLabel}
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
  </header>

  <div class="room-nav-content">
    <RoomInvites {collapsed} />

    <div class="room-nav-actions" class:collapsed>
      {#if directSection}
        <a
          class="sable-selection-layer"
          href={newChatHref}
          onclick={() => onNavigate?.(newChatHref)}
          aria-label={collapsed ? $i18n.t('nav.newChat') : undefined}
        >
          <span class="action-icon" aria-hidden="true"><PlusIcon /></span>
          {#if !collapsed}<span>{$i18n.t('nav.newChat')}</span>{/if}
        </a>
      {:else}
        {#if canCreateHere}
          <a
            class="sable-selection-layer"
            href={createRoomHref}
            onclick={() => onNavigate?.(createRoomHref)}
            aria-label={collapsed ? createRoomLabel : undefined}
          >
            <span class="action-icon" aria-hidden="true"><PlusIcon /></span>
            {#if !collapsed}<span>{createRoomLabel}</span>{/if}
          </a>
        {/if}
        <a
          class="sable-selection-layer"
          href={browseHref}
          onclick={() => onNavigate?.(browseHref)}
          aria-label={collapsed ? browseLabel : undefined}
        >
          <span class="action-icon" aria-hidden="true">
            {#if activeSpace === null}<CompassIcon />{:else}<FlagIcon />{/if}
          </span>
          {#if !collapsed}<span>{browseLabel}</span>{/if}
        </a>
      {/if}
    </div>

    {#if !collapsed}
      <button
        type="button"
        class="rooms-heading sable-selection-layer"
        aria-expanded={!roomsClosed}
        aria-controls={roomListId}
        onclick={() => {
          roomsClosed = !roomsClosed;
        }}
      >
        <span class:closed={roomsClosed} class="category-caret" aria-hidden="true"
          ><CaretDownIcon /></span
        >
        <span class="rooms-heading-label">{listLabel}</span>
      </button>
    {/if}

    <div id={roomListId}>
      {#if rooms.length === 0 && subspaces.length === 0}
        {#if !collapsed && !roomsClosed}
          <div class="empty-rooms">
            <p>{listEmpty}</p>
          </div>
        {/if}
      {:else}
        <div class="room-list" class:collapsed>
          {#each visibleRooms as item (item.key)}
            {#if item.kind === 'category'}
              {@const name = roomName(item.room)}
              {@const isClosed = closedCategories.has(item.key)}
              <div class="room-row-wrap">
                <button
                  type="button"
                  class="room-category sable-selection-layer"
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
                {#if !collapsed}
                  <RoomOptionsMenu room={item.room} onSettings={openSettings} onLeave={openLeave} />
                {/if}
              </div>
            {:else if isRoom(item)}
              {@const room = item.room}
              {@const name = room ? roomName(room) : item.roomId}
              {@const href = roomHref(item)}
              {@const unread =
                room && !roomList.mutedRoomIds.has(room.room_id)
                  ? room.highlight || room.unread
                  : 0}
              <div class="room-row-wrap">
                <a
                  class="room-row sable-selection-layer"
                  class:active={page.url.pathname === href}
                  {href}
                  style:--room-depth={collapsed ? 0 : item.depth}
                  onclick={() => onNavigate?.(href)}
                  aria-label={collapsed ? name : undefined}
                  aria-current={page.url.pathname === href ? 'page' : undefined}
                >
                  <span class="room-icon" aria-hidden="true">
                    {#if room?.avatar_url}
                      <MediaImage
                        source={room.avatar_url}
                        alt=""
                        width={56}
                        height={56}
                        class="room-image"
                      />
                    {:else}
                      {initial(name)}
                    {/if}
                  </span>
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
                {#if !collapsed && room}
                  <RoomOptionsMenu
                    {room}
                    parentSpaceId={item.parentSpaceId ?? null}
                    onSettings={openSettings}
                    onLeave={openLeave}
                  />
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  </div>
</section>

<RoomSettingsDialog
  open={settingsRoom !== null}
  room={settingsRoom}
  onOpenChange={(open) => {
    if (!open) settingsRoomId = null;
  }}
/>

<LeaveRoomDialog
  open={leaveRoom !== null}
  room={leaveRoom}
  onOpenChange={(open) => {
    if (!open) leaveRoomId = null;
  }}
/>

<style>
  .room-nav {
    background: var(--sable-bg-container);
    border-right: 1px solid var(--sable-surface-container-line);
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

  .room-nav-actions {
    display: grid;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem 0.5rem;
  }

  .room-nav-actions a {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-medium);
    gap: var(--space-2);
    height: var(--control-height-medium);
    padding: 0 0.5rem;
    text-align: left;
    text-decoration: none;
  }

  .room-nav-actions a:hover,
  .room-nav-actions a:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .room-nav-header.collapsed {
    justify-content: center;
    padding: 0;
  }

  .room-nav-header.collapsed h2 {
    display: flex;
  }

  .room-nav-actions.collapsed {
    justify-items: center;
    padding: 0.25rem 0;
  }

  .room-nav-actions.collapsed a {
    justify-content: center;
    padding: 0;
    width: var(--control-height-medium);
  }

  .action-icon,
  .category-caret {
    align-items: center;
    display: inline-flex;
    flex: 0 0 var(--icon-size-large);
    height: var(--icon-size-large);
    justify-content: center;
    line-height: 0;
    width: var(--icon-size-large);
  }

  .room-nav-actions :global(svg),
  .rooms-heading :global(svg) {
    display: block;
    height: var(--icon-size-large);
    width: var(--icon-size-large);
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
    gap: var(--space-2);
    height: var(--control-height-medium);
    padding: 0 0.5rem;
    text-align: left;
    width: 100%;
  }

  .rooms-heading:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  @media (hover: hover) and (pointer: fine) {
    .rooms-heading:hover {
      background: var(--sable-bg-container-hover);
    }
  }

  .rooms-heading-label {
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .empty-rooms {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    padding: 0.5rem 1rem;
  }

  .room-list {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
    padding: 0 0.5rem 0.5rem;
  }

  .room-row-wrap {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    min-width: 0;
    padding-right: 0.25rem;
  }

  .room-row-wrap:focus-within {
    background: var(--sable-bg-container-hover);
  }

  @media (hover: hover) and (pointer: fine) {
    .room-row-wrap:hover {
      background: var(--sable-bg-container-hover);
    }
  }

  /* A subspace heading opens a group, so it needs air above it to read as a
     break rather than as one more row. */
  .room-row-wrap:has(.room-category):not(:first-child) {
    margin-top: var(--space-2);
  }

  .room-row {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    flex: 1;
    gap: var(--space-2);
    min-height: var(--control-height-medium);
    min-width: 0;
    padding: 0 0.5rem 0 calc(0.5rem + var(--room-depth) * 1rem);
    text-decoration: none;
  }

  .room-row.active {
    color: var(--sable-bg-on-container);
  }

  .room-icon {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: flex;
    flex: 0 0 1.75rem;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 1.75rem;
    justify-content: center;
    overflow: hidden;
    width: 1.75rem;
  }

  :global(.room-image) {
    height: 100%;
    width: 100%;
  }

  :global(.room-image .media-image-content) {
    object-fit: cover;
    object-position: center;
  }

  .room-category {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    gap: 0.25rem;
    min-height: var(--control-height-medium);
    padding: 0 0.5rem 0 calc(0.5rem + var(--room-depth) * 1rem);
    text-align: left;
    text-transform: uppercase;
    width: 100%;
  }

  .category-caret.closed {
    transform: rotate(-90deg);
  }

  .category-caret :global(svg) {
    height: 1rem;
    width: 1rem;
  }

  .rooms-heading .category-caret :global(svg) {
    height: var(--icon-size-large);
    width: var(--icon-size-large);
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
    border-radius: var(--radius-pill);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    margin-left: auto;
    min-width: 1.25rem;
    padding: 0.125rem 0.375rem;
    text-align: center;
  }

  .room-badge.highlight {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .room-list.collapsed {
    justify-items: center;
    padding: 0 0 0.5rem;
  }

  .room-list.collapsed .room-row-wrap {
    justify-content: center;
    padding-right: 0;
  }

  .room-list.collapsed .room-row {
    flex: none;
    justify-content: center;
    padding: 0;
    width: var(--avatar-size-small);
  }

  .room-list.collapsed .room-category {
    flex: none;
    justify-content: center;
    margin: 0 auto;
    padding: 0;
    width: var(--avatar-size-small);
  }

  :is(.room-nav-actions a, .room-category, .rooms-heading):focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  @media (width >= 48rem) {
    .room-nav {
      flex: 0 0 var(--room-nav-width);
      width: var(--room-nav-width);
    }

    .room-nav-actions a,
    .rooms-heading {
      height: var(--control-height-small);
    }

    .room-nav-actions.collapsed a {
      width: var(--control-height-small);
    }

    .room-row {
      min-height: var(--control-height-small);
    }

    .room-category {
      min-height: 2rem;
    }
  }
</style>
