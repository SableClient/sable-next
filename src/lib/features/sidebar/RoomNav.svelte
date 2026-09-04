<script lang="ts">
  import type { Component } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { NotificationModeView } from '#src/generated/NotificationModeView';
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
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import BellRingingIcon from 'phosphor-svelte/lib/BellRingingIcon';
  import BellSlashIcon from 'phosphor-svelte/lib/BellSlashIcon';
  import GlobeSimpleIcon from 'phosphor-svelte/lib/GlobeSimpleIcon';
  import HashIcon from 'phosphor-svelte/lib/HashIcon';
  import HashStraightIcon from 'phosphor-svelte/lib/HashStraightIcon';
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import FlagIcon from 'phosphor-svelte/lib/FlagIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import TypingDots from '#lib/ui/primitives/TypingDots.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import LeaveRoomDialog from '#lib/features/room/LeaveRoomDialog.svelte';
  import { preferences, readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import {
    roomIconOverride,
    showsRoomIcon,
  } from '#lib/features/room/settings/room-appearance.svelte.js';
  import RoomSettingsDialog from '#lib/features/room/RoomSettingsDialog.svelte';
  import { bannerChanges, readRoomBanner } from '#lib/features/room/room-banner.svelte.js';

  import RoomInvites from './RoomInvites.svelte';
  import RoomOptionsMenu from './RoomOptionsMenu.svelte';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import { DropdownMenu } from 'bits-ui';
  import { claimedRoomIds, markRoomsRead } from './nav-rooms.js';
  import { publishVisibleRoomOrder } from './visible-rooms.svelte.js';
  import { navSectionKind, navSectionLabels, type NavSectionKind } from './nav-section.js';

  let contextRoom = $state<RoomSummary | null>(null);
  let contextParentSpaceId = $state<string | null>(null);
  let contextAnchor = $state.raw<CursorAnchor | null>(null);
  let contextOpen = $state(false);

  function openContextMenu(
    event: MouseEvent,
    room: RoomSummary,
    parentSpaceId: string | null
  ): void {
    event.preventDefault();
    event.stopPropagation();
    contextRoom = room;
    contextParentSpaceId = parentSpaceId;
    contextAnchor = cursorAnchor(event);
    contextOpen = true;
  }

  interface Props {
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
  }

  let { onNavigate, width, collapsed = false }: Props = $props();
  const roomList = useRoomList();
  const core = useCoreClient();
  const presenceStore = usePresenceStore();

  function dmPeerId(room: RoomSummary): string | null {
    if (room.direct_targets.length === 0) return null;
    const own = core.session?.user_id;
    return room.direct_targets.find((target) => target !== own) ?? room.direct_targets[0];
  }
  let settingsRoomId = $state<string | null>(null);
  let leaveRoomId = $state<string | null>(null);
  let spacePermissions = $state<RoomPermissionsView | null>(null);

  let directSection = $derived(page.url.pathname.startsWith('/direct'));
  let unspacedSection = $derived(page.url.pathname.startsWith('/rooms'));

  let activeSpace = $derived(
    page.url.pathname.startsWith('/space')
      ? (findRoomByPathId(roomList.rooms, page.params.spaceId) ?? null)
      : null
  );

  // The id, not the summary: a room list diff hands back a fresh object for the
  // same space, and the permission effect below would re-run on every one.
  let activeSpaceId = $derived(activeSpace?.room_id ?? null);
  let iconMode = $derived(roomIconOverride(activeSpaceId) ?? preferences.showRoomIcon);
  let showIcons = $derived(showsRoomIcon(iconMode, collapsed));
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

  const searchHref = resolve('/(app)/search');
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
  const SECTION_ICONS: Record<NavSectionKind, Component> = {
    direct: ChatsIcon,
    unspaced: HashIcon,
    space: HouseIcon,
    home: HouseIcon,
  };

  let section = $derived(navSectionKind(page.url.pathname));
  let labels = $derived(navSectionLabels(section));
  let listLabel = $derived($i18n.t(labels.list));
  let listEmpty = $derived($i18n.t(labels.empty));
  let title = $derived.by(() => {
    if (section !== 'space') return $i18n.t(labels.title);

    const space = findRoomByPathId(roomList.rooms, page.params.spaceId);

    return space?.name ?? $i18n.t(labels.title);
  });
  let TitleIcon = $derived(SECTION_ICONS[section]);
  let spaceRootItems = $derived.by<RoomNavItem[]>(() => {
    if (!page.url.pathname.startsWith('/space')) return [];

    const space = findRoomByPathId(roomList.rooms, page.params.spaceId);
    if (!space?.is_space) return [];

    const roomsById = new Map(
      roomList.rooms
        .filter((room) => room.state === 'joined' && !room.is_tombstoned)
        .map((room) => [room.room_id, room])
    );
    return spaceItems(space, roomsById, [space.room_id], space.room_id);
  });
  let rooms = $derived.by<RoomNavRow[]>(() => {
    if (directSection) {
      return roomList.rooms
        .filter((room) => room.state === 'joined' && room.is_direct)
        .map(roomRow)
        .toSorted(byRecency);
    }

    if (page.url.pathname.startsWith('/space')) {
      return spaceRootItems.filter(isRoom);
    }

    const claimedByJoinedSpace = unspacedSection
      ? claimedRoomIds(roomList.rooms)
      : new Set<string>();

    return roomList.rooms
      .filter(
        (room) =>
          room.state === 'joined' &&
          !room.is_space &&
          !(unspacedSection && room.is_direct) &&
          !claimedByJoinedSpace.has(room.room_id)
      )
      .map(roomRow)
      .toSorted(byRecency);
  });
  $effect(() => {
    publishVisibleRoomOrder(rooms.map((row) => row.roomId));
  });
  let subspaces = $derived(spaceRootItems.filter((item) => item.kind === 'category'));
  let visibleSubspaces = $derived<RoomNavItem[]>(visibleItems(subspaces));
  let collapsedRooms = $derived(
    rooms.filter((item) => {
      const room = item.room;
      if (room === undefined) return false;
      if (page.url.pathname === roomHref(item)) return true;
      if (room.marked_unread) return true;
      return !roomList.mutedRoomIds.has(room.room_id) && (room.unread > 0 || room.highlight > 0);
    })
  );
  let visibleRooms = $derived<RoomNavItem[]>([
    ...(roomsClosed ? collapsedRooms : rooms),
    ...visibleSubspaces,
  ]);

  function roomRow(room: RoomSummary): RoomNavRow {
    return { room, roomId: room.room_id, depth: 0, kind: 'room', key: room.room_id };
  }

  function byRecency(left: RoomNavRow, right: RoomNavRow): number {
    return (right.room?.latest_event?.timestamp ?? 0) - (left.room?.latest_event?.timestamp ?? 0);
  }

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

    if (unspacedSection) {
      return resolve('/(app)/rooms/[roomId]', { roomId: routeId });
    }

    return resolve('/(app)/home/[roomId]', { roomId: routeId });
  }

  let banner = $state<string | null>(null);

  $effect(() => {
    const spaceId = activeSpaceId;
    void bannerChanges.version;
    if (spaceId === null) {
      banner = null;
      return;
    }

    let current = true;
    banner = null;
    void readRoomBanner(core, spaceId).then((next) => {
      if (current) banner = next;
    });
    return () => {
      current = false;
    };
  });

  let bannerShown = $derived(banner !== null && !collapsed && preferences.showRoomBanners);

  function notificationChip(mode: NotificationModeView): { icon: Component; label: string } {
    if (mode === 'mute') return { icon: BellSlashIcon, label: 'room.notifyMute' };
    if (mode === 'mentions') return { icon: BellIcon, label: 'room.notifyMentions' };

    return { icon: BellRingingIcon, label: 'room.notifyAll' };
  }

  function roomGlyph(room: RoomSummary | undefined): Component {
    if (room === undefined) return HashStraightIcon;
    if (room.is_voice) return SpeakerHighIcon;
    if (room.join_rule === 'public') return GlobeSimpleIcon;
    if (room.join_rule === 'invite' || room.join_rule === 'knock' || room.join_rule === 'private') {
      return LockSimpleIcon;
    }

    return HashStraightIcon;
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
    void core.commands
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

  let sectionUnread = $derived(
    rooms.some((item) => {
      const room = item.room;
      return (
        room !== undefined &&
        (room.marked_unread ||
          (!roomList.mutedRoomIds.has(room.room_id) && (room.unread > 0 || room.highlight > 0)))
      );
    })
  );

  function markSectionRead(): void {
    markRoomsRead(
      rooms.map((item) => item.room),
      core.commands,
      readReceiptIsPrivate()
    );
  }

  function openSettings(room: RoomSummary): void {
    settingsRoomId = room.room_id;
  }

  function openLeave(room: RoomSummary): void {
    leaveRoomId = room.room_id;
  }
</script>

<!-- eslint-disable @typescript-eslint/no-confusing-void-expression -- the rule
     reads every {@render} of a local snippet as a void expression -->
<section
  class="room-nav"
  aria-label={listLabel}
  style:--room-nav-width={width === undefined ? undefined : String(width) + 'px'}
>
  <div class="room-nav-top">
    {#if bannerShown && banner}
      <div class="room-banner">
        <MediaImage source={banner} alt="" width={640} height={190} class="room-banner-image" />
      </div>
    {/if}
    <header class="room-nav-header" class:collapsed class:on-banner={bannerShown}>
      <h2 aria-label={collapsed ? title : undefined}>
        {#if collapsed}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="room-nav-badge sable-open"
              aria-label={$i18n.t('nav.listOptions')}
            >
              {#if activeSpace}
                <Avatar src={activeSpace.avatar_url} name={title} size="small" />
              {:else}
                <TitleIcon />
              {/if}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content class="sable-menu" side="right" align="start" sideOffset={4}>
              {@render listMenuItems()}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {:else}
          {title}
        {/if}
      </h2>
      {#if !collapsed}
        <div class="room-nav-header-actions">
          {#if activeSpace && activeSpace.join_rule !== 'public'}
            <span
              class="title-lock"
              role="img"
              aria-label={$i18n.t(`room.joinRule.${activeSpace.join_rule}`)}
            >
              <LockSimpleIcon />
            </span>
          {/if}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="room-nav-menu sable-open"
              aria-label={$i18n.t('nav.listOptions')}
            >
              <DotsThreeVerticalIcon />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content class="sable-menu" side="bottom" align="end" sideOffset={4}>
              {@render listMenuItems()}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      {/if}
    </header>
  </div>

  {#snippet listMenuItems()}
    <DropdownMenu.Item class="sable-menu-item" disabled={!sectionUnread} onSelect={markSectionRead}>
      <ChecksIcon />
      {$i18n.t('nav.markSectionRead')}
    </DropdownMenu.Item>
    {#if activeSpace}
      <DropdownMenu.Item
        class="sable-menu-item"
        onSelect={() => {
          openSettings(activeSpace);
        }}
      >
        <GearIcon />
        {$i18n.t('room.menuSettings')}
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="sable-menu-item sable-menu-item-destructive"
        onSelect={() => {
          openLeave(activeSpace);
        }}
      >
        <SignOutIcon />
        {$i18n.t('room.menuLeaveSpace')}
      </DropdownMenu.Item>
    {/if}
  {/snippet}

  <div class="room-nav-content">
    <RoomInvites {collapsed} />

    <div class="room-nav-actions" class:collapsed>
      {#snippet action(href: string, label: string, icon: Component)}
        {@const Icon = icon}
        {@const active = page.url.pathname === href}
        <a
          class="nav-action sable-current sable-selection-layer"
          {href}
          onclick={() => onNavigate?.(href)}
          aria-label={collapsed ? label : undefined}
          aria-current={active ? 'page' : undefined}
        >
          <span class="room-icon" aria-hidden="true"
            ><Icon weight={active ? 'fill' : 'regular'} /></span
          >
          {#if !collapsed}<span class="room-text"><span class="room-name">{label}</span></span>{/if}
        </a>
      {/snippet}
      {#if directSection}
        {@render action(newChatHref, $i18n.t('nav.newChat'), PlusIcon)}
      {:else}
        {#if canCreateHere}
          {@render action(createRoomHref, createRoomLabel, PlusIcon)}
        {/if}
        {@render action(browseHref, browseLabel, activeSpace === null ? CompassIcon : FlagIcon)}
        {@render action(searchHref, $i18n.t('nav.messageSearch'), MagnifyingGlassIcon)}
      {/if}
    </div>

    {#if !collapsed}
      <button
        type="button"
        class="rooms-heading sable-selection-layer"
        aria-expanded={!roomsClosed}
        data-state={roomsClosed ? 'closed' : 'open'}
        aria-controls={roomListId}
        onclick={() => {
          roomsClosed = !roomsClosed;
        }}
      >
        <span class="rooms-heading-label">{listLabel}</span>
        <span class:closed={roomsClosed} class="category-caret" aria-hidden="true"
          ><CaretDownIcon /></span
        >
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
                  oncontextmenu={(event) => {
                    openContextMenu(event, item.room, null);
                  }}
                  style:--room-depth={collapsed ? 0 : item.depth}
                  aria-label={collapsed ? `${name} (${$i18n.t('nav.space')})` : undefined}
                  aria-expanded={!isClosed}
                  data-state={isClosed ? 'closed' : 'open'}
                  onclick={() => {
                    toggleCategory(item.key);
                  }}
                >
                  {#if !collapsed}<span class="category-name">{name}</span>{/if}
                  <span class:closed={isClosed} class="category-caret" aria-hidden="true"
                    ><CaretDownIcon /></span
                  >
                </button>
                {#if !collapsed}
                  <RoomOptionsMenu room={item.room} onSettings={openSettings} onLeave={openLeave} />
                {/if}
              </div>
            {:else if isRoom(item)}
              {@const room = item.room}
              {@const name = room ? roomName(room) : item.roomId}
              {@const href = roomHref(item)}
              {@const active = page.url.pathname === href}
              {@const muted = !room || roomList.mutedRoomIds.has(room.room_id)}
              {@const mentions = muted ? 0 : room.highlight}
              {@const unread = muted ? 0 : room.unread}
              {@const marked = room?.marked_unread ?? false}
              {@const live = room?.call_participants.length ?? 0}
              {@const notifyMode = room ? roomList.notificationOverride(room.room_id) : null}
              {@const typing =
                !preferences.hideTypingIndicators &&
                room !== undefined &&
                roomList.typingRoomIds.has(room.room_id) &&
                mentions === 0 &&
                unread === 0 &&
                !marked}
              {@const peerId = room?.is_direct ? dmPeerId(room) : null}
              {@const peerPresence = peerId ? presenceStore.get(peerId) : null}
              <div class="room-row-wrap">
                <a
                  oncontextmenu={(event) => {
                    if (room) openContextMenu(event, room, item.parentSpaceId ?? null);
                  }}
                  class="room-row sable-current sable-selection-layer"
                  class:unread={mentions > 0 || unread > 0 || marked}
                  {href}
                  style:--room-depth={collapsed ? 0 : item.depth}
                  onclick={() => onNavigate?.(href)}
                  aria-label={collapsed ? name : undefined}
                  aria-current={active ? 'page' : undefined}
                >
                  {#if showIcons}
                    <span class="room-avatar">
                      <Avatar
                        class={[
                          'room-avatar-icon',
                          { glyph: !room?.avatar_url, voice: room?.is_voice },
                        ]}
                        src={room?.avatar_url ?? null}
                        size="small"
                        uniform
                      >
                        {@const Glyph = roomGlyph(room)}
                        <Glyph weight={active ? 'fill' : 'regular'} />
                      </Avatar>
                      {#if peerPresence && peerPresence.presence !== 'offline'}
                        <PresenceDot
                          presence={peerPresence.presence}
                          label={$i18n.t(`presence.${peerPresence.presence}`)}
                          class="room-presence"
                        />
                      {/if}
                    </span>
                  {/if}
                  {#if !collapsed}
                    <span class="room-text">
                      <span class="room-name">{name}</span>
                      {#if room?.is_direct && room.topic}
                        <span class="room-topic">{room.topic}</span>
                      {/if}
                    </span>
                    {#if typing}
                      <span class="room-typing"><TypingDots /></span>
                    {/if}
                    {#if live > 0}
                      <span
                        class="voice-badge"
                        aria-label={$i18n.t('nav.voiceLive', { count: live })}>{live}</span
                      >
                    {/if}
                    <UnreadBadge
                      counts={{ unread, highlight: mentions, marked }}
                      dm={room?.is_direct ?? false}
                      role="img"
                      aria-label={mentions > 0
                        ? $i18n.t('nav.unreadMentions', { count: mentions })
                        : unread > 0
                          ? $i18n.t('nav.unreadMessages', { count: unread })
                          : $i18n.t('nav.markedUnread')}
                    />
                    {#if notifyMode}
                      {@const chip = notificationChip(notifyMode)}
                      <span class="room-mode" role="img" aria-label={$i18n.t(chip.label)}>
                        <chip.icon />
                      </span>
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

{#if contextRoom}
  <RoomOptionsMenu
    room={contextRoom}
    parentSpaceId={contextParentSpaceId}
    anchor={contextAnchor}
    align="start"
    side="right"
    bind:open={contextOpen}
    onSettings={openSettings}
    onLeave={openLeave}
  />
{/if}

<style>
  .room-nav {
    background: var(--sable-bg-container);
    border-right: var(--border-width) solid var(--sable-surface-container-line);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .room-nav-top {
    flex: none;
    position: relative;
  }

  .room-banner {
    height: 11.875rem;
    overflow: hidden;
  }

  .room-banner :global(.room-banner-image),
  .room-banner :global(img) {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .room-nav-header {
    align-items: center;
    display: flex;
    flex: 0 0 2.875rem;
    gap: var(--space-100);
    justify-content: space-between;
    min-height: 2.875rem;
    padding: 0 var(--space-300) 0 var(--space-400);
  }

  .room-nav-header.on-banner {
    background: linear-gradient(
      180deg,
      var(--sable-media-scrim) 0%,
      var(--sable-media-scrim-clear) 100%
    );
    color: var(--sable-media-on-scrim);
    left: 0;
    position: absolute;
    right: 0;
    top: 0;
  }

  .room-nav-header.on-banner :global(.room-nav-menu) {
    color: inherit;
  }

  .room-nav-header.on-banner :global(.room-nav-menu:hover),
  .room-nav-header.on-banner :global(.room-nav-menu[data-state='open']) {
    background: var(--sable-media-scrim-hover);
    color: inherit;
  }

  .room-nav-header-actions {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-100);
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.room-nav-badge) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    padding: 0;
  }

  :global(.room-nav-badge svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  :global(.room-nav-badge:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  .title-lock {
    align-items: center;
    display: inline-flex;
    flex: none;
    opacity: var(--opacity-p300);
  }

  .title-lock :global(svg) {
    height: var(--size-x200);
    width: var(--size-x200);
  }

  :global(.room-nav-menu) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    flex: none;
    height: 1.75rem;
    justify-content: center;
    padding: 0;
    width: 1.75rem;
  }

  :global(.room-nav-menu:hover) {
    background: var(--sable-surface-container-hover);
    color: var(--sable-surface-on-container);
  }

  :global(.room-nav-menu:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.room-nav-menu svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .room-nav-actions {
    display: grid;
    gap: var(--space-100);
    padding: var(--space-100) var(--space-200) var(--space-200);
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
    padding: var(--space-100) 0;
  }

  .room-nav-actions.collapsed a {
    justify-content: center;
    padding: 0;
    width: var(--control-height-medium);
  }

  .category-caret {
    align-items: center;
    display: inline-flex;
    flex: 0 0 var(--icon-size-large);
    height: var(--icon-size-large);
    justify-content: center;
    line-height: 0;
    width: var(--icon-size-large);
  }

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
    gap: var(--space-100);
    height: var(--control-height-medium);
    opacity: var(--opacity-p300);
    padding: 0 var(--space-200);
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
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    margin: 0;
  }

  .empty-rooms {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    padding: var(--space-200) var(--space-400);
  }

  .room-list {
    display: grid;
    gap: var(--space-100);
    min-width: 0;
    padding: 0 var(--space-200) var(--space-200);
  }

  .room-row-wrap {
    --kebab-gutter: calc(var(--space-200) + 1.75rem);

    align-items: center;
    border-radius: var(--radius);
    display: flex;
    min-width: 0;
    position: relative;
  }

  .room-row-wrap :global(.room-options-trigger) {
    position: absolute;
    right: var(--space-100);
    top: 50%;
    translate: 0 -50%;
  }

  @media (hover: hover) and (pointer: fine) {
    .room-row-wrap :global(.room-options-trigger) {
      opacity: 0;
    }

    .room-row-wrap:hover :global(.room-options-trigger),
    .room-row-wrap:focus-within :global(.room-options-trigger),
    .room-row-wrap :global(.room-options-trigger[data-state='open']) {
      opacity: 1;
    }
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
    margin-top: var(--space-300);
  }

  .room-row,
  .nav-action {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    flex: 1;
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    min-height: var(--control-height-medium);
    min-width: 0;
    padding: 0 var(--kebab-gutter, var(--space-300)) 0
      calc(var(--space-200) + var(--room-depth, 0) * var(--space-400));
    text-decoration: none;
  }

  .room-row[aria-current='page'] {
    background: var(--sable-surface-container-active);
    color: var(--sable-surface-on-container);
  }

  .room-row[aria-current='page']:hover {
    background: var(--sable-surface-container-hover);
    color: var(--sable-surface-on-container);
  }

  .nav-action[aria-current='page'] {
    background: var(--sable-surface-container-active);
    color: var(--sable-surface-on-container);
  }

  .nav-action[aria-current='page']:hover {
    background: var(--sable-surface-container-hover);
    color: var(--sable-surface-on-container);
  }

  .room-row.unread {
    font-weight: var(--font-weight-600);
  }

  .room-avatar {
    display: inline-flex;
    flex: none;
    position: relative;
  }

  .room-icon {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    flex: 0 0 1.5rem;
    height: 1.5rem;
    justify-content: center;
    overflow: hidden;
    width: 1.5rem;
  }

  :global(.room-avatar-icon) {
    --avatar-size: 1.5rem;
  }

  :global(.room-avatar .room-presence) {
    bottom: -0.125rem;
    position: absolute;
    right: -0.125rem;
  }

  :global(.room-avatar-icon.glyph) {
    opacity: var(--opacity-p300);
  }

  .room-row.unread :global(.room-avatar-icon.glyph),
  .room-row[aria-current='page'] :global(.room-avatar-icon.glyph) {
    opacity: var(--opacity-p500);
  }

  .room-row[aria-current='page'] :global(.room-avatar-icon) {
    box-shadow: inset 0 0 0 var(--border-width) var(--sable-primary-main);
  }

  .room-icon :global(svg),
  :global(.room-avatar-icon svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
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
    font-weight: var(--font-weight-500);
    gap: var(--space-100);
    min-height: var(--control-height-medium);
    opacity: var(--opacity-p300);
    padding: 0 var(--kebab-gutter, var(--space-300)) 0
      calc(var(--space-200) + var(--room-depth, 0) * var(--space-400));
    text-align: left;
    width: 100%;
  }

  .category-caret.closed {
    transform: rotate(-90deg);
  }

  .category-caret :global(svg) {
    height: 1rem;
    width: 1rem;
  }

  .category-name,
  .room-name,
  .room-topic {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .category-name {
    flex: 0 1 auto;
  }

  .room-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .room-topic {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-400);
    line-height: var(--line-height-small);
    margin-top: calc(-1 * var(--space-050));
    opacity: var(--opacity-p300);
  }

  .room-typing,
  .room-mode {
    align-items: center;
    display: flex;
    flex: none;
  }

  .room-typing {
    background: var(--sable-sec-container);
    border: var(--border-width) solid var(--sable-sec-container-line);
    border-radius: var(--radius-pill);
    height: 1.25rem;
    padding: 0 var(--space-150);
  }

  .room-mode {
    opacity: var(--opacity-p300);
  }

  .room-mode :global(svg) {
    height: var(--size-x200);
    width: var(--size-x200);
  }

  :global(.room-avatar-icon.voice) {
    font-size: var(--font-size-body);
  }

  .voice-badge {
    align-items: center;
    background: var(--sable-primary-main);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-main);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    min-width: 1.25rem;
    padding: var(--space-050) var(--space-150);
  }

  .room-list.collapsed {
    justify-items: center;
    padding: 0 0 var(--space-200);
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

    .rooms-heading {
      height: var(--control-height-small);
    }

    .room-nav-actions.collapsed a {
      width: var(--control-height-small);
    }

    .room-row,
    .nav-action {
      min-height: 2.25rem;
    }

    .room-category {
      min-height: 2rem;
    }
  }
</style>
