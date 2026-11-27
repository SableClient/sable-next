<script lang="ts">
  import { tick, untrack, type Component } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { HOME_SECTION } from '#lib/rooms/last-room.js';
  import { voiceChat } from '#lib/features/room/voice-chat.svelte.js';
  import {
    findRoomByPathId,
    roomPathParam,
    roomPathParamFromId,
    useRoomList,
  } from '#lib/rooms/room-list.svelte.js';
  import { SvelteSet } from 'svelte/reactivity';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import ThreadIcon from 'phosphor-svelte/lib/ScribbleLoopIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon';
  import HashIcon from 'phosphor-svelte/lib/HashIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { longPress, mouseContextMenu } from '#lib/ui/long-press.svelte.js';
  import { isDeclining } from '#lib/rooms/invites.svelte.js';
  import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { hasUnread, NO_UNREAD } from '#lib/rooms/unread.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import RoomIcon from '#lib/ui/primitives/RoomIcon.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { rovingFocus } from '#lib/ui/roving-focus.js';
  import LeaveRoomDialog from '#lib/features/room/LeaveRoomDialog.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { isBridgedSpace } from '#lib/rooms/bridged-spaces.svelte.js';
  import { unreadDot } from '#lib/rooms/quiet-rooms.svelte.js';
  import {
    spaceBridgeBadgeChanges,
    spaceHidesBridgeBadges,
  } from '#lib/rooms/space-bridge-badges.svelte.js';
  import { roomIconOverride, showsRoomAvatar } from '#lib/rooms/room-appearance.svelte.js';
  import RoomInviteDialog from '#lib/features/room/RoomInviteDialog.svelte';
  import RoomSettingsDialog from '#lib/features/room/settings/RoomSettingsDialog.svelte';
  import { goToPage } from '#lib/features/room/room-navigation.js';
  import SpaceEvents from '#lib/features/calendar/SpaceEvents.svelte';

  import type { CallVoiceState } from '#lib/features/call/call-session.svelte.js';
  import CallVolumePopover from '#lib/features/call/CallVolumePopover.svelte';
  import MentionProfile from '#lib/features/room/members/MentionProfile.svelte';
  import GroupAvatar from './GroupAvatar.svelte';
  import BridgeBadge from './BridgeBadge.svelte';
  import CallParticipantList from './CallParticipantList.svelte';
  import CategoryCaret from './CategoryCaret.svelte';
  import ReplacedRooms from './ReplacedRooms.svelte';
  import RoomInvites from './RoomInvites.svelte';
  import RoomNavActions from './RoomNavActions.svelte';
  import RoomListHeading from './RoomListHeading.svelte';
  import RoomListMenuItems from './RoomListMenuItems.svelte';
  import RoomListSortButton from './RoomListSortButton.svelte';
  import RoomNavHeader from './RoomNavHeader.svelte';
  import RoomOptionsButton from './RoomOptionsButton.svelte';
  import RoomOptionsMenu from './RoomOptionsMenu.svelte';
  import RoomRowStatus from './RoomRowStatus.svelte';
  import RoomRowText, { type RoomPreview } from './RoomRowText.svelte';
  import RoomThreadLines from './RoomThreadLines.svelte';
  import {
    saveThreadSidebarAction,
    useThreadSidebar,
    type SidebarThread,
  } from './thread-sidebar.svelte.js';
  import RoomVoiceLive from './RoomVoiceLive.svelte';
  import { claimedRoomIds, markRoomsRead } from './nav-rooms.js';
  import { roomRow, type RoomNavRow } from './nav-rows.js';
  import { PeerProfiles } from './peer-profiles.svelte.js';
  import { VirtualWindow } from '#lib/ui/virtual-window.svelte.js';
  import { publishVisibleRoomOrder } from './visible-rooms.svelte.js';
  import { navSectionKind, navSectionLabels, type NavSectionKind } from './nav-section.js';
  import {
    flattenSpaceTree,
    spaceTreeNodes,
    type SpaceTreeRoom,
    type SpaceTreeSpace,
  } from './space-tree.js';
  import { unreadLabel } from './unread-label.js';

  const ESTIMATED_ROW_HEIGHT = 36;
  const OVERSCAN_ROWS = 10;
  const WARM_DWELL_MS = 300;
  let contextRoom = $state.raw<RoomListItemView | null>(null);
  let contextParentSpaceId = $state<string | null>(null);
  let contextAnchor = $state.raw<HTMLElement | CursorAnchor | null>(null);
  let contextOpen = $state(false);
  let optionsRoomId = $derived(
    contextOpen && contextAnchor !== null && 'focus' in contextAnchor
      ? (contextRoom?.room_id ?? null)
      : null
  );
  let contextThread = $state.raw<{ roomId: string; thread: SidebarThread } | null>(null);
  let contextThreadAnchor = $state.raw<HTMLElement | CursorAnchor | null>(null);
  let contextThreadOpen = $state(false);
  let optionsThreadKey = $derived(
    contextThreadOpen &&
      contextThreadAnchor !== null &&
      'focus' in contextThreadAnchor &&
      contextThread
      ? `${contextThread.roomId}:${contextThread.thread.id}`
      : null
  );

  function openContextMenu(
    event: MouseEvent,
    room: RoomListItemView,
    parentSpaceId: string | null
  ): void {
    event.preventDefault();
    event.stopPropagation();
    contextThreadOpen = false;
    contextRoom = room;
    contextParentSpaceId = parentSpaceId;
    contextAnchor = cursorAnchor(event);
    contextOpen = true;
  }

  function toggleOptionsMenu(
    trigger: HTMLElement,
    room: RoomListItemView,
    parentSpaceId: string | null
  ): void {
    if (optionsRoomId === room.room_id && contextAnchor === trigger) {
      contextOpen = false;
      return;
    }
    contextThreadOpen = false;
    contextRoom = room;
    contextParentSpaceId = parentSpaceId;
    contextAnchor = trigger;
    contextOpen = true;
  }

  function openThreadContextMenu(
    event: MouseEvent,
    target: { roomId: string; thread: SidebarThread }
  ): void {
    event.preventDefault();
    event.stopPropagation();
    contextOpen = false;
    contextThread = target;
    contextThreadAnchor = cursorAnchor(event);
    contextThreadOpen = true;
  }

  function toggleThreadOptionsMenu(
    trigger: HTMLElement,
    target: { roomId: string; thread: SidebarThread }
  ): void {
    if (
      optionsThreadKey === `${target.roomId}:${target.thread.id}` &&
      contextThreadAnchor === trigger
    ) {
      contextThreadOpen = false;
      return;
    }
    contextOpen = false;
    contextThread = target;
    contextThreadAnchor = trigger;
    contextThreadOpen = true;
  }

  function threadDiscovery(roomId: string, revision: string, includeActive: boolean) {
    return whenVisible(
      () => threadSidebar?.discover(roomId, revision, includeActive),
      '0px',
      WARM_DWELL_MS
    );
  }

  interface Props {
    pathname?: string;
    spaceId?: string;
    roomId?: string;
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
    callRoomId?: string | null;
    callParticipants?: readonly string[];
    callVoiceStates?: ReadonlyMap<string, CallVoiceState>;
    onCallVolume?: (userId: string, volume: number) => void;
    pinnedSpaceIds?: ReadonlySet<string>;
    onTogglePin?: (roomId: string) => void;
  }

  let {
    pathname = page.url.pathname,
    spaceId = page.params.spaceId,
    roomId = page.params.roomId,
    onNavigate,
    width,
    collapsed = false,
    callRoomId = null,
    callParticipants = [],
    callVoiceStates = new Map(),
    onCallVolume,
    pinnedSpaceIds = new Set(),
    onTogglePin,
  }: Props = $props();

  let volumeTarget = $state<{ userId: string; name: string; anchor: HTMLElement } | null>(null);
  let volumeOpen = $state(false);

  function openCallVolume(event: MouseEvent, userId: string, name: string): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    volumeTarget = { userId, name, anchor: event.currentTarget };
    volumeOpen = true;
  }

  let participantTarget = $state.raw<{
    userId: string;
    roomId: string;
    anchor: HTMLElement;
  } | null>(null);
  let participantOpen = $state(false);

  function openParticipant(event: MouseEvent, roomId: string, userId: string): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    participantTarget = { userId, roomId, anchor: event.currentTarget };
    participantOpen = true;
  }
  const roomList = useRoomList();
  const threadSidebar = useThreadSidebar();
  let linkedThread = $derived(page.url.searchParams.get('thread'));
  const core = useCoreClient();
  const presenceStore = usePresenceStore();

  function dmPeerId(room: RoomListItemView): string | null {
    const own = core.session?.user_id;
    if (!own) return null;
    const peers = room.direct_targets.filter((target) => target !== own);
    return peers.length === 1 ? peers[0] : null;
  }

  const PREVIEW_LABELS = {
    image: 'nav.previewImage',
    video: 'nav.previewVideo',
    audio: 'nav.previewAudio',
    voice: 'nav.previewVoice',
    file: 'nav.previewFile',
    sticker: 'nav.previewSticker',
    location: 'nav.previewLocation',
    poll: 'nav.previewPoll',
  } as const;

  function messagePreview(room: RoomListItemView): RoomPreview | null {
    const mode = preferences.messagePreviews;
    const shown = room.is_direct
      ? mode === 'direct' || mode === 'all'
      : mode === 'rooms' || mode === 'all';
    const event = room.latest_event;
    if (!shown || !event) return null;
    let text = event.body;
    if (event.kind !== 'text') {
      const label = i18n.t(PREVIEW_LABELS[event.kind]);
      text = text ? i18n.t('nav.previewCaption', { label, caption: text }) : label;
    }
    if (!text) return null;
    const sender = event.own ? i18n.t('nav.previewYou') : event.sender_label;
    return { sender, text, emotes: event.emotes };
  }

  const peerProfiles = new PeerProfiles(core);
  let settingsRoomId = $state<string | null>(null);
  let leaveRoomId = $state<string | null>(null);
  let inviteRoomId = $state<string | null>(null);

  let directSection = $derived(pathname.startsWith('/direct'));
  let unspacedSection = $derived(pathname.startsWith('/rooms'));

  let activeSpace = $derived(
    pathname.startsWith('/space') ? (findRoomByPathId(roomList.rooms, spaceId) ?? null) : null
  );

  let activeSpaceId = $derived(activeSpace?.room_id ?? null);
  let activeRoom = $derived(
    activeSpace ? (findRoomByPathId(roomList.rooms, roomId) ?? null) : null
  );
  let iconMode = $derived(roomIconOverride(activeSpaceId) ?? preferences.showRoomIcon);
  let spaceHidesBadges = $state(false);
  let showBridgeBadges = $derived(
    preferences.showBridgeBadges && !isBridgedSpace(activeSpaceId) && !spaceHidesBadges
  );

  $effect(() => {
    const target = activeSpaceId;
    void spaceBridgeBadgeChanges.version;
    spaceHidesBadges = false;
    if (!target) return;
    let current = true;
    void spaceHidesBridgeBadges(core, target).then((hidden) => {
      if (current) spaceHidesBadges = hidden;
    });
    return () => {
      current = false;
    };
  });

  function navigateTo(href: string): void {
    if (onNavigate) {
      onNavigate(href);
    } else {
      goToPage(href);
    }
  }

  function openLobby(room: RoomListItemView): void {
    navigateTo(
      resolve('/(app)/space/[spaceId]/lobby', { spaceId: roomPathParam(room, roomList.rooms) })
    );
  }

  // Held by id so the dialogs follow the live summary.
  let settingsRoom = $derived(roomList.byId(settingsRoomId) ?? null);
  let leaveRoom = $derived(roomList.byId(leaveRoomId) ?? null);
  let inviteRoom = $derived(roomList.byId(inviteRoomId) ?? null);

  type RoomNavItem = SpaceTreeSpace | RoomNavRow;

  const closedCategories = new SvelteSet<string>();
  const roomListId = $props.id();
  const favouritesListId = `${roomListId}-favourites`;
  let roomsClosed = $state(false);
  let favouritesClosed = $state(false);

  const SECTION_ICONS: Record<NavSectionKind, Component> = {
    direct: ChatsIcon,
    unspaced: HashIcon,
    space: HouseIcon,
    home: HouseIcon,
  };

  let section = $derived(navSectionKind(pathname));
  let labels = $derived(navSectionLabels(section));
  let listLabel = $derived(i18n.t(labels.list));
  let listEmpty = $derived(i18n.t(labels.empty));
  let title = $derived.by(() => {
    if (section !== 'space') return i18n.t(labels.title);

    const space = findRoomByPathId(roomList.rooms, spaceId);

    return space?.name ?? i18n.t(labels.title);
  });
  let titleHref = $derived(
    section === 'home'
      ? resolve('/(app)/home')
      : section === 'unspaced'
        ? resolve('/(app)/rooms')
        : undefined
  );
  let TitleIcon = $derived(SECTION_ICONS[section]);
  let spacedRoomIds = $derived(claimedRoomIds(roomList.rooms));
  let sortKey = $derived<'directSort' | 'roomSort'>(directSection ? 'directSort' : 'roomSort');
  let favouriteView = $derived(activeSpaceId ?? section);
  let navSection = $derived(roomList.section(favouriteView));

  function listedRooms(roomIds: readonly string[] | undefined): RoomListItemView[] {
    return (roomIds ?? []).flatMap((roomId) => roomList.byId(roomId) ?? []);
  }

  function sectionRows(roomIds: readonly string[] | undefined, keyed: boolean): RoomNavRow[] {
    const listed = listedRooms(roomIds);
    if (activeSpaceId === null) return listed.map(roomRow);
    const spaceId = activeSpaceId;
    return listed.map((room): SpaceTreeRoom => ({
      kind: 'room',
      room,
      roomId: room.room_id,
      parentSpaceId: spaceId,
      depth: 0,
      key: keyed ? `${spaceId}/${room.room_id}` : room.room_id,
      threads: [],
    }));
  }

  let favourites = $derived(sectionRows(navSection?.favourites, false));
  let rooms = $derived(sectionRows(navSection?.rooms, true));
  let sectionRooms = $derived([...favourites, ...rooms]);
  let invites = $derived(
    listedRooms(navSection?.invites).filter(
      (room) => !isDeclining(room.room_id) && !dismissedInvites.has(room.room_id)
    )
  );
  $effect(() => {
    publishVisibleRoomOrder(
      sectionRooms.map((row) => row.roomId),
      section === 'home' ? HOME_SECTION : activeSpaceId
    );
  });
  let calendarRooms = $derived(listedRooms(navSection?.calendars));
  let subspaces = $derived(
    activeSpaceId === null
      ? []
      : spaceTreeNodes(navSection?.subspaces ?? [], activeSpaceId, (roomId) =>
          roomList.byId(roomId)
        )
  );
  let visibleSubspaces = $derived<RoomNavItem[]>(
    flattenSpaceTree(subspaces, {
      closed: (key) => closedCategories.has(key),
      keep: stillShownRow,
    })
  );
  const rowWindow = new VirtualWindow(() => ({
    count: roomsClosed ? 0 : rooms.length,
    key: (index) => rooms[index].key,
    estimate: ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
  }));
  let windowedRooms = $derived(
    roomsClosed
      ? rooms.map((item, index) => ({ index, item }))
      : rowWindow.items.flatMap(({ index }) =>
          rooms[index] ? [{ index, item: rooms[index] }] : []
        )
  );
  let activeIndex = $derived(rooms.findIndex((item) => pathname === roomHref(item)));

  $effect(() => {
    void pathname;
    untrack(() => {
      if (activeIndex < 0) return;
      void tick().then(() => {
        rowWindow.scrollToIndex(activeIndex);
      });
    });
  });

  function focusEdge(move: 'start' | 'end', from: HTMLElement, distance: number): void {
    if (distance !== Infinity) return;
    const tree = from.closest<HTMLElement>('[role="tree"]');
    if (!tree) return;
    if (move === 'start') tree.closest<HTMLElement>('.room-nav-content')?.scrollTo({ top: 0 });
    void settleEdge(move).then(() => {
      const items = tree.querySelectorAll<HTMLElement>('[role="treeitem"]');
      items[move === 'end' ? items.length - 1 : 0]?.focus();
    });
  }

  // Rows measured on the way down change the list's height, so one scroll can stop short of the end.
  async function settleEdge(move: 'start' | 'end'): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (move === 'end') rowWindow.scrollToIndex(rooms.length - 1);
      await tick();
      await new Promise(requestAnimationFrame);
      if (move === 'start' ? rowWindow.first === 0 : rowWindow.last === rooms.length) return;
    }
  }

  function stillShownRow(item: RoomNavRow): boolean {
    const room = item.room;
    if (room === undefined) return false;
    if (pathname === roomHref(item)) return true;
    return hasUnread(roomList.badgeUnreadFor(room));
  }

  function roomHref(row: RoomNavRow) {
    const routeId = row.room
      ? roomPathParam(row.room, roomList.rooms)
      : roomPathParamFromId(row.roomId);
    if (directSection) {
      return resolve('/(app)/direct/[roomId]', { roomId: routeId });
    }

    if (row.parentSpaceId) {
      const parentSpace = findRoomByPathId(roomList.rooms, row.parentSpaceId);
      return resolve('/(app)/space/[spaceId]/[roomId]', {
        spaceId: parentSpace
          ? roomPathParam(parentSpace, roomList.rooms)
          : roomPathParamFromId(row.parentSpaceId),
        roomId: routeId,
      });
    }

    if (unspacedSection) {
      return resolve('/(app)/rooms/[roomId]', { roomId: routeId });
    }

    // The disabled Home layout redirects to /rooms and drops the selected room.
    if (!preferences.showHome) return roomSectionPath(roomList.rooms, row.roomId);

    return resolve('/(app)/home/[roomId]', { roomId: routeId });
  }

  function toggleCategory(key: string) {
    if (closedCategories.has(key)) closedCategories.delete(key);
    else closedCategories.add(key);
  }

  function isRoom(item: RoomNavItem): item is RoomNavRow {
    return item.kind === 'room';
  }

  let sectionUnread = $derived(
    sectionRooms.some((item) => {
      const room = item.room;
      return room !== undefined && hasUnread(roomList.badgeUnreadFor(room));
    })
  );

  function markSectionRead(): void {
    markRoomsRead(
      sectionRooms.map((item) => item.room),
      core.rpc.timeline
    );
  }

  function openSettings(room: RoomListItemView): void {
    settingsRoomId = room.room_id;
  }

  function openLeave(room: RoomListItemView): void {
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
  <RoomNavHeader
    {activeSpace}
    {activeRoom}
    {title}
    {titleHref}
    {onNavigate}
    titleIcon={TitleIcon}
    {collapsed}
    actions={activeSpace ? undefined : roomSortControl}
    menuItems={listMenuItems}
  />

  {#snippet listMenuItems()}
    <RoomListMenuItems
      {activeSpace}
      {favouriteView}
      markReadDisabled={!sectionUnread}
      onMarkRead={markSectionRead}
      onInvite={(room) => {
        inviteRoomId = room.room_id;
      }}
      onSettings={openSettings}
      onLeave={openLeave}
    />
  {/snippet}

  {#snippet roomSortControl()}
    <RoomListSortButton {sortKey} />
  {/snippet}

  {#snippet optionsButton(room: RoomListItemView, parentSpaceId: string | null)}
    <RoomOptionsButton
      open={optionsRoomId === room.room_id}
      onToggle={(trigger) => {
        toggleOptionsMenu(trigger, room, parentSpaceId);
      }}
    />
  {/snippet}

  {#snippet navRoom(item: RoomNavRow, sectionClosed: boolean, position?: number)}
    {@const room = item.room}
    {@const name = room ? room.display_name : item.roomId}
    {@const avatarUrl = room ? room.display_avatar_url : null}
    {@const href = roomHref(item)}
    {@const active = pathname === href}
    {@const counts = room ? roomList.badgeUnreadFor(room) : NO_UNREAD}
    {@const mentions = counts.highlight}
    {@const unread = counts.unread}
    {@const marked = counts.marked ?? false}
    {@const countLabel = unreadLabel(counts)}
    {@const participants =
      item.roomId === callRoomId && callParticipants.length > 0
        ? callParticipants
        : (room?.call_participants ?? [])}
    {@const live = participants.length}
    {@const voicePlacement =
      room?.room_kind === 'voice' ? preferences.voiceParticipantPlacement : null}
    {@const roomLabel =
      collapsed && voicePlacement === 'inline' && live > 0
        ? `${name}, ${i18n.t('nav.voiceLive', { count: live })}`
        : name}
    {@const notifyMode = room ? roomList.notificationOverride(room.room_id) : null}
    {@const typing =
      !preferences.hideTypingIndicators &&
      room !== undefined &&
      roomList.typingUsers.has(room.room_id) &&
      mentions === 0 &&
      unread === 0 &&
      !marked}
    {@const peerId = room?.is_direct ? dmPeerId(room) : null}
    {@const peerPresence = peerId ? presenceStore.peek(peerId) : null}
    {@const peerStatus = peerId ? resolveUserStatus(peerProfiles.get(peerId), peerPresence) : null}
    {@const preview = room ? messagePreview(room) : null}
    {@const closed = sectionClosed && !(room !== undefined && (active || hasUnread(counts)))}
    {@const sidebarThreads = !collapsed && !closed ? (threadSidebar?.rows(item.roomId) ?? []) : []}
    {@const selectedThread = active && sidebarThreads.some((thread) => thread.id === linkedThread)}
    {@const revision = room?.latest_event?.event_id ?? ''}
    <div class={['room-row-wrap', { 'closed-row': closed }]} data-row-key={item.key}>
      <RoomThreadLines threads={item.threads} {collapsed} />
      {#snippet roomTrigger({ props }: { props: Record<string, unknown> })}
        <!-- eslint-disable svelte/no-navigation-without-resolve -- roomHref() resolves the route itself -->
        <a
          {...props}
          role="treeitem"
          aria-level={collapsed ? 1 : 2}
          aria-setsize={position === undefined ? undefined : rooms.length}
          aria-posinset={position}
          draggable="false"
          oncontextmenu={mouseContextMenu((event) => {
            if (room) openContextMenu(event, room, item.parentSpaceId ?? null);
          })}
          {@attach longPress({
            enabled: () => room !== undefined,
            onPress: (event) => {
              if (room) openContextMenu(event, room, item.parentSpaceId ?? null);
            },
          })}
          class={[
            'room-row selection-current selection-layer',
            { unread: mentions > 0 || unread > 0 || marked },
          ]}
          {href}
          style:--room-depth={collapsed ? 0 : item.depth}
          onclick={() => onNavigate?.(href)}
          aria-label={collapsed
            ? countLabel
              ? `${roomLabel}, ${countLabel}`
              : roomLabel
            : undefined}
          aria-current={active && !selectedThread ? 'page' : undefined}
          {@attach threadSidebar && room?.state === 'joined' && !collapsed && !closed
            ? threadDiscovery(item.roomId, revision, preferences.showActiveThreadsInSidebar)
            : undefined}
          {@attach peerId !== null && !collapsed
            ? whenVisible(() => {
                peerProfiles.request(peerId);
              })
            : undefined}
          {@attach whenVisible(
            () => {
              roomList.warm(item.roomId);
            },
            '0px',
            WARM_DWELL_MS
          )}
        >
          {#if (room?.is_direct ?? false) || showsRoomAvatar(iconMode, collapsed, Boolean(avatarUrl))}
            {#snippet glyph()}
              <RoomIcon
                roomKind={room?.room_kind ?? null}
                hasParent={spacedRoomIds.has(item.roomId)}
                joinRule={room?.join_rule ?? null}
                weight={active ? 'fill' : 'regular'}
              />
            {/snippet}
            <span class="room-avatar">
              {#if avatarUrl}
                <Avatar
                  class={['room-avatar-icon', { voice: room?.room_kind === 'voice' }]}
                  id={item.roomId}
                  src={avatarUrl}
                  size="small"
                  uniform
                  recolor={!room?.is_direct}
                >
                  {@render glyph()}
                </Avatar>
              {:else if room && room.group_members.length > 0}
                <GroupAvatar members={room.group_members.slice(0, 2)} />
              {:else if room && (room.is_direct || unspacedSection)}
                <Avatar class="room-avatar-icon" id={item.roomId} {name} size="small" />
              {:else}
                <div
                  class={[
                    'avatar-root avatar-small room-avatar-icon glyph',
                    { voice: room?.room_kind === 'voice' },
                  ]}
                  aria-hidden="true"
                >
                  <span class="avatar-fallback">{@render glyph()}</span>
                </div>
              {/if}
              {#if room?.bridge && showBridgeBadges}
                {@const bridge = room.bridge}
                <Tooltip label={i18n.t('nav.bridgedFrom', { network: bridge.network })}>
                  {#snippet trigger({ props })}
                    <BridgeBadge {...props} {bridge} />
                  {/snippet}
                </Tooltip>
              {/if}
              {#if peerPresence && peerPresence.presence !== 'offline'}
                <PresenceDot
                  presence={peerPresence.presence}
                  label={i18n.t(`presence.${peerPresence.presence}`)}
                  class="room-presence"
                  size="medium"
                />
              {/if}
            </span>
          {:else}
            <span class="room-icon" aria-hidden="true">
              <RoomIcon
                roomKind={room?.room_kind ?? null}
                hasParent={spacedRoomIds.has(item.roomId)}
                joinRule={room?.join_rule ?? null}
                weight={active ? 'fill' : 'regular'}
              />
            </span>
          {/if}
          {#if !collapsed}
            <RoomRowText {name} {room} {preview} {peerStatus} />
          {/if}
          {#if room && live > 0 && (!collapsed || voicePlacement === 'inline')}
            <RoomVoiceLive
              {participants}
              showFaces={voicePlacement !== 'below'}
              showCount={!collapsed}
              profiles={peerProfiles}
            />
          {/if}
          <RoomRowStatus
            {counts}
            dm={room?.is_direct ?? false}
            {typing}
            {collapsed}
            {notifyMode}
            dotHidden={room !== undefined && unreadDot(room.room_id) === 'hide'}
          />
        </a>
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
      {/snippet}
      {#if collapsed}
        <Tooltip label={roomLabel} side="right" trigger={roomTrigger} />
      {:else}
        {#if room?.canonical_alias && !room.is_direct}
          <Tooltip label={room.canonical_alias} side="right" trigger={roomTrigger} />
        {:else}
          {@render roomTrigger({ props: {} })}
        {/if}
        {#if room && !collapsed}
          <span class="room-options-slot">
            {#if room.room_kind === 'voice'}
              <button
                class="room-options-trigger"
                type="button"
                tabindex="-1"
                aria-hidden="true"
                aria-label={i18n.t(active && voiceChat.open ? 'call.hideChat' : 'call.showChat')}
                aria-pressed={active && voiceChat.open}
                onclick={() => {
                  voiceChat.open = !(active && voiceChat.open);
                  if (!active) navigateTo(href);
                }}
              >
                <ChatCircleIcon weight={active && voiceChat.open ? 'fill' : 'regular'} />
              </button>
            {/if}
            {@render optionsButton(room, item.parentSpaceId ?? null)}
          </span>
        {/if}
      {/if}
    </div>
    {#if sidebarThreads.length > 0}
      {@const parentLines = (item.threads ?? [])
        .filter((line) => line.kind !== 'last')
        .map((line) => ({ ...line, kind: 'through' as const }))}
      {#each sidebarThreads as thread, index (thread.id)}
        {@const name = thread.title || i18n.t('timeline.thread')}
        {@const threadHref =
          href +
          '?thread=' +
          encodeURIComponent(thread.id) +
          (room?.room_kind === 'calendar' ? '&timeline=events' : '')}
        {@const isSelected = active && linkedThread === thread.id}
        {@const threadTarget = { roomId: item.roomId, thread }}
        <div class="room-row-wrap thread-row">
          <RoomThreadLines
            threads={[
              ...parentLines,
              {
                level: item.depth,
                kind: index === sidebarThreads.length - 1 ? ('last' as const) : ('branch' as const),
              },
            ]}
            collapsed={false}
          />
          <!-- eslint-disable svelte/no-navigation-without-resolve -- the parent room href is already resolved -->
          <a
            class={['room-row selection-current selection-layer', { unread: thread.unread }]}
            style:--room-depth={item.depth + 1}
            href={threadHref}
            role="treeitem"
            aria-level={3}
            aria-selected={isSelected}
            aria-current={isSelected ? 'page' : undefined}
            aria-label={thread.unread ? i18n.t('nav.unreadThread', { name }) : name}
            oncontextmenu={mouseContextMenu((event) => {
              openThreadContextMenu(event, threadTarget);
            })}
            {@attach longPress({
              onPress: (event) => {
                openThreadContextMenu(event, threadTarget);
              },
            })}
            onclick={() => onNavigate?.(threadHref)}
          >
            <ThreadIcon size={16} aria-hidden="true" />
            <span>{name}</span>
            {#if thread.pinned || thread.unread}
              <span class="thread-row-status" aria-hidden="true">
                {#if thread.pinned}<PushPinIcon size={14} weight="fill" />{/if}
                {#if thread.unread}<span class="thread-unread-dot"></span>{/if}
              </span>
            {/if}
          </a>
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
          <span class="room-options-slot">
            <RoomOptionsButton
              label={i18n.t('timeline.threadMenu')}
              open={optionsThreadKey === `${item.roomId}:${thread.id}`}
              onToggle={(trigger) => {
                toggleThreadOptionsMenu(trigger, threadTarget);
              }}
            />
          </span>
        </div>
      {/each}
    {/if}
    {#if room && (voicePlacement === 'both' || voicePlacement === 'below') && live > 0}
      <CallParticipantList
        {participants}
        screenSharers={room.screen_sharers}
        {collapsed}
        {closed}
        voiceStates={room.room_id === callRoomId ? callVoiceStates : undefined}
        profiles={peerProfiles}
        onVolume={openCallVolume}
        onParticipant={(event, userId) => {
          openParticipant(event, room.room_id, userId);
        }}
      />
    {/if}
  {/snippet}

  {#snippet navLink(item: SpaceTreeSpace)}
    {@const room = item.room}
    {@const name = room.display_name}
    {@const href = resolve('/(app)/space/[spaceId]/lobby', {
      spaceId: roomPathParam(room, roomList.rooms),
    })}
    {@const active = pathname === href}
    <div class="room-row-wrap" data-row-key={item.key}>
      <RoomThreadLines threads={item.threads} {collapsed} />
      {#snippet linkTrigger({ props }: { props: Record<string, unknown> })}
        <a
          {...props}
          role="treeitem"
          aria-level={collapsed ? 1 : 2}
          draggable="false"
          oncontextmenu={mouseContextMenu((event) => {
            openContextMenu(event, room, null);
          })}
          {@attach longPress({
            onPress: (event) => {
              openContextMenu(event, room, null);
            },
          })}
          class="room-row room-link selection-current selection-layer"
          {href}
          style:--room-depth={collapsed ? 0 : item.depth}
          onclick={() => onNavigate?.(href)}
          aria-label={collapsed ? name : undefined}
          aria-current={active ? 'page' : undefined}
        >
          <span class="room-avatar">
            <Avatar
              class={['room-avatar-icon', { glyph: !room.display_avatar_url }]}
              id={room.display_avatar_url ? room.room_id : null}
              src={room.display_avatar_url}
              size="small"
              uniform
            >
              <RoomIcon
                roomKind={room.room_kind}
                joinRule={room.join_rule}
                weight={active ? 'fill' : 'regular'}
              />
            </Avatar>
          </span>
          {#if !collapsed}
            <RoomRowText {name} />
            <span class="room-link-icon" aria-hidden="true"><SquaresFourIcon /></span>
          {/if}
        </a>
      {/snippet}
      {#if collapsed}
        <Tooltip label={name} side="right" trigger={linkTrigger} />
      {:else}
        {@render linkTrigger({ props: {} })}
        {#if !collapsed}
          <span class="room-options-slot">
            {@render optionsButton(room, null)}
          </span>
        {/if}
      {/if}
    </div>
  {/snippet}

  <div class="room-nav-content" {@attach rowWindow.scroller}>
    <RoomNavActions {pathname} {activeSpace} {collapsed} {onNavigate} />

    {#if !collapsed && activeSpace && preferences.showSpaceEvents && calendarRooms.length > 0}
      <SpaceEvents
        spaceId={roomPathParam(activeSpace, roomList.rooms)}
        rooms={calendarRooms}
        {onNavigate}
      />
    {/if}

    <RoomInvites {collapsed} {invites} />

    <div
      role="tree"
      data-focus-region="rooms"
      aria-label={listLabel}
      {@attach rovingFocus({ tree: true, onBoundary: focusEdge })}
    >
      {#if favourites.length > 0}
        {#if !collapsed}
          <RoomListHeading
            label={i18n.t('nav.favourites')}
            closed={favouritesClosed}
            controls={favouritesListId}
            onToggle={() => {
              favouritesClosed = !favouritesClosed;
            }}
          />
        {/if}
        <div id={favouritesListId} class={['room-list favourites', { collapsed }]}>
          {#each favourites as item (item.key)}
            {@render navRoom(item, favouritesClosed)}
          {/each}
        </div>
      {/if}

      {#if !collapsed}
        <RoomListHeading
          label={listLabel}
          closed={roomsClosed}
          controls={roomListId}
          onToggle={() => {
            roomsClosed = !roomsClosed;
          }}
        />
      {/if}

      <div id={roomListId}>
        {#if sectionRooms.length === 0 && subspaces.length === 0}
          {#if !collapsed && !roomsClosed}
            <div class="empty-rooms">
              <p>{listEmpty}</p>
            </div>
          {/if}
        {:else}
          <div class={['room-list', { collapsed }]}>
            <div
              aria-hidden="true"
              style:height="{rowWindow.spaceBefore}px"
              {@attach rowWindow.start}
            ></div>
            {#each windowedRooms as { index, item } (item.key)}
              <div
                class={['window-row', { 'closed-row': roomsClosed && !stillShownRow(item) }]}
                data-index={index}
                {@attach rowWindow.measure}
              >
                {@render navRoom(item, roomsClosed, index + 1)}
              </div>
            {/each}
            <div aria-hidden="true" style:height="{rowWindow.spaceAfter}px"></div>
            {#each visibleSubspaces as item (item.key)}
              {#if item.kind === 'category'}
                {@const name = item.room.display_name}
                {@const isClosed = closedCategories.has(item.key)}
                <div class="room-row-wrap">
                  <RoomThreadLines threads={item.threads} {collapsed} />
                  {#snippet categoryTrigger({ props }: { props: Record<string, unknown> })}
                    <button
                      {...props}
                      type="button"
                      role="treeitem"
                      aria-level="1"
                      class={['room-category selection-layer', { collapsed }]}
                      oncontextmenu={mouseContextMenu((event) => {
                        openContextMenu(event, item.room, null);
                      })}
                      {@attach longPress({
                        onPress: (event) => {
                          openContextMenu(event, item.room, null);
                        },
                      })}
                      style:--room-depth={collapsed ? 0 : item.depth}
                      aria-label={collapsed ? `${name} (${i18n.t('nav.space')})` : undefined}
                      aria-expanded={!isClosed}
                      onclick={() => {
                        toggleCategory(item.key);
                      }}
                    >
                      {#if !collapsed}<span class="category-name"><bdi>{name}</bdi></span>{/if}
                      <CategoryCaret closed={isClosed} />
                    </button>
                  {/snippet}
                  {#if collapsed}
                    <Tooltip label={name} side="right" trigger={categoryTrigger} />
                  {:else}
                    {@render categoryTrigger({ props: {} })}
                    <span class="room-options-slot">
                      {@render optionsButton(item.room, null)}
                    </span>
                  {/if}
                </div>
              {:else if item.kind === 'link'}
                {@render navLink(item)}
              {:else if isRoom(item)}
                {@render navRoom(item, false)}
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    </div>
    {#if unspacedSection}<ReplacedRooms {collapsed} />{/if}
  </div>
</section>

{#if volumeTarget}
  <CallVolumePopover
    bind:open={volumeOpen}
    anchor={volumeTarget.anchor}
    userId={volumeTarget.userId}
    name={volumeTarget.name}
    onVolumeChange={onCallVolume}
  />
{/if}

{#if participantTarget}
  <MentionProfile
    bind:open={participantOpen}
    userId={participantTarget.userId}
    member={null}
    roomId={participantTarget.roomId}
    profile={peerProfiles.get(participantTarget.userId) ?? null}
    anchor={participantTarget.anchor}
  />
{/if}

<RoomSettingsDialog
  open={settingsRoom !== null}
  room={settingsRoom}
  onOpenChange={(open) => {
    if (!open) settingsRoomId = null;
  }}
/>

<RoomInviteDialog
  open={inviteRoom !== null}
  room={inviteRoom}
  onOpenChange={(open) => {
    if (!open) inviteRoomId = null;
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
  {@const fromTrigger = contextAnchor !== null && 'focus' in contextAnchor}
  {@const pinRoomId = contextRoom.room_id}
  {@const pinnable =
    onTogglePin !== undefined &&
    contextRoom.room_kind === 'space' &&
    contextRoom.state === 'joined'}
  {@const pinned = pinnedSpaceIds.has(pinRoomId)}
  {#key contextRoom.room_id}
    <RoomOptionsMenu
      room={contextRoom}
      parentSpaceId={contextParentSpaceId}
      anchor={contextAnchor}
      align={fromTrigger ? 'end' : 'start'}
      side={fromTrigger ? 'bottom' : 'right'}
      bind:open={contextOpen}
      onSettings={openSettings}
      onLeave={openLeave}
      onLobby={openLobby}
      onPin={pinnable && !pinned ? () => onTogglePin?.(pinRoomId) : undefined}
      onUnpin={pinnable && pinned ? () => onTogglePin?.(pinRoomId) : undefined}
    />
  {/key}
{/if}

{#if contextThread && threadSidebar}
  {@const fromTrigger = contextThreadAnchor !== null && 'focus' in contextThreadAnchor}
  {@const target = contextThread}
  {#key `${target.roomId}:${target.thread.id}`}
    <ActionMenu
      bind:open={contextThreadOpen}
      label={i18n.t('timeline.threadMenu')}
      class="room-options-menu"
      anchor={contextThreadAnchor}
      align={fromTrigger ? 'end' : 'start'}
      side={fromTrigger ? 'bottom' : 'right'}
    >
      <IconContext values={{ 'aria-hidden': 'true' }}>
        <ActionMenuItem
          disabled={!threadSidebar.ready}
          onSelect={() => {
            saveThreadSidebarAction(
              threadSidebar.togglePin(target.roomId, target.thread.id),
              'timeline.threadPinFailed',
              'personal pin'
            );
          }}
        >
          {#if threadSidebar.hasPin(target.roomId, target.thread.id)}
            <PushPinSlashIcon />
            {i18n.t('timeline.threadUnpin')}
          {:else}
            <PushPinIcon />
            {i18n.t('timeline.threadPin')}
          {/if}
        </ActionMenuItem>
        <ActionMenuItem
          disabled={!threadSidebar.ready}
          onSelect={() => {
            saveThreadSidebarAction(
              threadSidebar.setDismissed(target.roomId, target.thread.id, true),
              'timeline.threadDismissFailed',
              'sidebar dismissal'
            );
          }}
        >
          <EyeSlashIcon />
          {i18n.t('timeline.threadDismissSidebar')}
        </ActionMenuItem>
      </IconContext>
    </ActionMenu>
  {/key}
{/if}

<style>
  .room-nav {
    background: var(--bg-container);
    border-inline-end: var(--border-width) solid var(--bg-container-line);
    box-sizing: border-box;
    color: var(--bg-on-container);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  p {
    margin: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .room-row-wrap {
      transition: background-color var(--motion-fast) var(--motion-easing-standard);
    }
  }

  .room-nav-content {
    flex: 1;
    min-height: 0;
    overflow: hidden auto;
    overflow-anchor: none;
  }

  .window-row {
    display: grid;
    justify-items: inherit;
    min-width: 0;
  }

  .empty-rooms {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    padding: var(--space-200) var(--space-400);
  }

  .room-list {
    display: grid;
    min-width: 0;
    padding: 0 var(--space-200) var(--space-200);
    -webkit-touch-callout: none;
    user-select: none;
  }

  .room-row-wrap {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    min-width: 0;
    position: relative;
  }

  .room-options-slot {
    align-items: center;
    display: flex;
    flex: none;
    margin-inline-end: var(--space-100);
  }

  @media (any-hover: hover) and (any-pointer: fine) and (not (any-pointer: coarse)) {
    .room-list:not(.collapsed)
      .room-row-wrap:not(
        :has(:global(.room-status > *), :global(.voice-live), .thread-row-status)
      ):is(:hover, :focus-within)
      .room-row,
    .room-list:not(.collapsed)
      .room-row-wrap:not(
        :has(:global(.room-status > *), :global(.voice-live), .thread-row-status)
      ):has(:global(.room-options-trigger[data-state='open']))
      .room-row {
      padding-inline-end: calc(var(--space-100) + var(--space-600));
    }

    .room-options-slot {
      inset-inline-end: 0;
      margin-inline-end: var(--space-100);
      pointer-events: none;
      position: absolute;
      top: 50%;
      translate: 0 -50%;
      z-index: 1;
    }

    .room-options-slot :global(.room-options-trigger) {
      opacity: 0;
      pointer-events: none;
    }

    .room-row-wrap:hover .room-options-slot :global(.room-options-trigger),
    .room-row-wrap:focus-within .room-options-slot :global(.room-options-trigger),
    .room-options-slot :global(.room-options-trigger[data-state='open']) {
      opacity: 1;
      pointer-events: auto;
    }

    .room-row-wrap:is(:hover, :focus-within)
      :is(:global(.room-status), :global(.voice-live), .thread-row-status),
    .room-row-wrap:has(:global(.room-options-trigger[data-state='open']))
      :is(:global(.room-status), :global(.voice-live), .thread-row-status) {
      opacity: 0;
      pointer-events: none;
    }
  }

  .room-row-wrap:focus-within {
    --room-icon-plate: var(--bg-container-hover);

    background: var(--bg-container-hover);
  }

  .room-row-wrap.closed-row {
    display: none;
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .room-row-wrap:hover {
      --room-icon-plate: var(--bg-container-hover);

      background: var(--bg-container-hover);
    }
  }

  /* A subspace heading opens a group, so it needs air above it to read as a
     break rather than as one more row. */
  .room-list > :where(:not(.closed-row)) ~ .room-row-wrap:has(.room-category) {
    margin-top: var(--space-300);
  }

  .room-list
    > :where(:not(.closed-row))
    ~ .room-row-wrap:has(.room-category)
    :global(:is(.thread-line, .thread-elbow)) {
    top: calc(-1 * var(--space-300));
  }

  .room-link-icon {
    align-items: center;
    display: flex;
    flex: none;
    opacity: var(--opacity-p300);
    padding-inline-end: var(--space-100);
  }

  .room-link-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .room-row {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    font-weight: var(--font-weight-normal);
    gap: var(--space-200);
    min-height: 2.25rem;
    min-width: 0;
    padding: 0 var(--space-100) 0 calc(var(--space-200) + var(--room-depth, 0) * var(--space-400));
    text-decoration: none;
  }

  .room-row[aria-current='page'] {
    --room-icon-plate: var(--bg-container-active);

    background: var(--bg-container-active);
    color: var(--bg-on-container);
  }

  .room-row[aria-current='page']:hover {
    --room-icon-plate: var(--bg-container-active);

    background: var(--bg-container-active);
    color: var(--bg-on-container);
  }

  .room-row.unread {
    font-weight: var(--font-weight-bold);
  }

  .thread-row .room-row {
    font-size: var(--font-size-small);
    min-height: 1.875rem;
  }

  .thread-row :global(svg) {
    flex: none;
  }

  .thread-row .room-row > span:first-of-type {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-row-status {
    align-items: center;
    display: inline-flex;
    flex: none;
    gap: var(--space-100);
  }

  .thread-unread-dot {
    background: var(--primary-main);
    border-radius: var(--radii-round);
    flex: none;
    height: var(--space-200);
    width: var(--space-200);
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
    inset-inline-end: -0.125rem;
    bottom: -0.125rem;
    position: absolute;
  }

  :global(.room-avatar-icon.glyph) {
    opacity: var(--opacity-p300);
  }

  :global(.room-avatar-icon) :global(.media-image-tint) {
    color: var(--bg-on-container);
    inset: calc((var(--avatar-size) - var(--icon-size-small)) / 2);
    opacity: 1;
  }

  :global(.room-avatar-icon.glyph .avatar-fallback) {
    background: none;
  }

  .room-row.unread :global(.room-avatar-icon.glyph),
  .room-row[aria-current='page'] :global(.room-avatar-icon.glyph) {
    opacity: var(--opacity-p500);
  }

  .room-row[aria-current='page'] :global(.room-avatar-icon)::after {
    border-radius: inherit;
    box-shadow: inset 0 0 0 var(--border-width) var(--primary-main);
    content: '';
    inset: 0;
    position: absolute;
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
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-500);
    gap: var(--space-100);
    min-height: var(--control-height-medium);
    min-width: 0;
    opacity: var(--opacity-p300);
    padding: 0 var(--space-100) 0 calc(var(--space-200) + var(--room-depth, 0) * var(--space-400));
    text-align: start;
  }

  .room-category:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  .category-name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.room-avatar-icon.voice) {
    font-size: var(--font-size-body);
  }

  .room-list.collapsed {
    justify-items: center;
    padding: 0 0 var(--space-200);
  }

  .room-list.collapsed .room-row-wrap {
    justify-content: center;
    padding-inline-end: 0;
  }

  .room-list.collapsed .room-row {
    flex: none;
    justify-content: center;
    padding: 0;
    position: relative;
    width: var(--avatar-size-small);
  }

  .room-list.collapsed .room-row:has(:global(.voice-live)) {
    flex-direction: column;
    gap: var(--space-050);
    padding-block: var(--space-100);
  }

  .room-list.collapsed :global(.voice-live) {
    opacity: 1;
  }

  .room-list.collapsed :global(.voice-faces .avatar-root.voice-face) {
    --avatar-size: 1rem;
  }

  .room-list.collapsed .room-row :global(.room-collapsed-badge) {
    inset-inline-end: 0.125rem;
    position: absolute;
    top: 0.125rem;
  }

  .room-list.collapsed .room-category {
    flex: none;
    justify-content: center;
    margin: 0 auto;
    padding: 0;
    width: var(--avatar-size-small);
  }

  @media (--app-layout) {
    .room-nav {
      flex: 0 0 var(--room-nav-width);
      width: var(--room-nav-width);
    }

    .room-row {
      min-height: 2.25rem;
    }

    .room-category {
      min-height: 2rem;
    }
  }
</style>
