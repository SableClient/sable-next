<script lang="ts">
  import type { Component } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { NotificationModeView, RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { voiceChat } from '#lib/features/room/voice-chat.svelte.js';
  import {
    findRoomByPathId,
    roomAvatarUrl,
    roomLabel,
    roomPathParam,
    roomPathParamFromId,
    useRoomList,
  } from '#lib/rooms/room-list.svelte.js';
  import { SvelteSet } from 'svelte/reactivity';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import BellRingingIcon from 'phosphor-svelte/lib/BellRingingIcon';
  import BellSlashIcon from 'phosphor-svelte/lib/BellSlashIcon';
  import HashIcon from 'phosphor-svelte/lib/HashIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
  import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { longPress, mouseContextMenu } from '#lib/ui/long-press.svelte.js';
  import { isDeclining } from '#lib/rooms/invites.svelte.js';
  import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { hasUnread, NO_UNREAD } from '#lib/rooms/unread.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import { ROOM_SORTS, ROOM_SORT_LABELS } from '#lib/rooms/room-sort.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import RoomIcon from '#lib/ui/primitives/RoomIcon.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import TypingDots from '#lib/ui/primitives/TypingDots.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import LeaveRoomDialog from '#lib/features/room/LeaveRoomDialog.svelte';
  import {
    preferences,
    readReceiptIsPrivate,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import { roomIconOverride, showsRoomAvatar } from '#lib/rooms/room-appearance.svelte.js';
  import RoomSettingsDialog from '#lib/features/room/settings/RoomSettingsDialog.svelte';
  import { goToPage } from '#lib/features/room/room-navigation.js';
  import CalendarRowEvent from '#lib/features/calendar/CalendarRowEvent.svelte';
  import SpaceEvents from '#lib/features/calendar/SpaceEvents.svelte';

  import type { CallVoiceState } from '#lib/features/call/call-session.svelte.js';
  import CallVolumePopover from '#lib/features/call/CallVolumePopover.svelte';
  import MentionProfile from '#lib/features/room/members/MentionProfile.svelte';
  import { participantKeys } from '#lib/features/call/participant-keys.js';
  import CallParticipantList from './CallParticipantList.svelte';
  import ReplacedRooms from './ReplacedRooms.svelte';
  import RoomInvites from './RoomInvites.svelte';
  import RoomNavActions from './RoomNavActions.svelte';
  import RoomNavHeader from './RoomNavHeader.svelte';
  import RoomOptionsMenu from './RoomOptionsMenu.svelte';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import { groupsFavourites, setGroupsFavourites } from '#lib/rooms/favourite-grouping.svelte.js';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import { claimedRoomIds, markRoomsRead } from './nav-rooms.js';
  import {
    isFavourite,
    roomComparator,
    roomRow,
    treeRows,
    withoutFavourites,
    type RoomNavRow,
  } from './nav-rows.js';
  import { PeerProfiles } from './peer-profiles.svelte.js';
  import { publishVisibleRoomOrder } from './visible-rooms.svelte.js';
  import { navSectionKind, navSectionLabels, type NavSectionKind } from './nav-section.js';
  import {
    flattenSpaceTree,
    spaceTree as buildSpaceTree,
    type SpaceTreeNode,
    type SpaceTreeRoom,
    type SpaceTreeSpace,
    type Thread,
  } from './space-tree.js';

  const MAX_VOICE_FACES = 3;
  const WARM_DWELL_MS = 300;
  let contextRoom = $state<RoomListItemView | null>(null);
  let contextParentSpaceId = $state<string | null>(null);
  let contextAnchor = $state.raw<HTMLElement | CursorAnchor | null>(null);
  let contextOpen = $state(false);
  let optionsRoomId = $derived(
    contextOpen && contextAnchor !== null && 'focus' in contextAnchor
      ? (contextRoom?.room_id ?? null)
      : null
  );

  function openContextMenu(
    event: MouseEvent,
    room: RoomListItemView,
    parentSpaceId: string | null
  ): void {
    event.preventDefault();
    event.stopPropagation();
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
    contextRoom = room;
    contextParentSpaceId = parentSpaceId;
    contextAnchor = trigger;
    contextOpen = true;
  }

  interface Props {
    pathname?: string;
    spaceId?: string;
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
    callRoomId?: string | null;
    callVoiceStates?: ReadonlyMap<string, CallVoiceState>;
    onCallVolume?: (userId: string, volume: number) => void;
  }

  let {
    pathname = page.url.pathname,
    spaceId = page.params.spaceId,
    onNavigate,
    width,
    collapsed = false,
    callRoomId = null,
    callVoiceStates = new Map(),
    onCallVolume,
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
  const core = useCoreClient();
  const presenceStore = usePresenceStore();

  function dmPeerId(room: RoomListItemView): string | null {
    if (room.direct_targets.length === 0) return null;
    const own = core.session?.user_id;
    return room.direct_targets.find((target) => target !== own) ?? room.direct_targets[0];
  }

  const peerProfiles = new PeerProfiles(core);
  let settingsRoomId = $state<string | null>(null);
  let leaveRoomId = $state<string | null>(null);

  let directSection = $derived(pathname.startsWith('/direct'));
  let unspacedSection = $derived(pathname.startsWith('/rooms'));

  let activeSpace = $derived(
    pathname.startsWith('/space') ? (findRoomByPathId(roomList.rooms, spaceId) ?? null) : null
  );

  let activeSpaceId = $derived(activeSpace?.room_id ?? null);
  let iconMode = $derived(roomIconOverride(activeSpaceId) ?? preferences.showRoomIcon);

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
  let TitleIcon = $derived(SECTION_ICONS[section]);
  let spaceTree = $derived.by<SpaceTreeNode[]>(() => {
    if (!pathname.startsWith('/space')) return [];

    const space = findRoomByPathId(roomList.rooms, spaceId);
    if (space?.room_kind !== 'space') return [];

    const roomsById = new Map(
      roomList.rooms
        .filter(
          (room) => room.state === 'joined' && !(room.room_kind === 'space' && room.is_tombstoned)
        )
        .map((room) => [room.room_id, room])
    );
    return buildSpaceTree(space, roomsById, Number(preferences.subspaceHierarchyLimit));
  });
  let spacedRoomIds = $derived(claimedRoomIds(roomList.rooms));
  let sortKey = $derived<'directSort' | 'roomSort'>(directSection ? 'directSort' : 'roomSort');
  let compareRooms = $derived(roomComparator(preferences[sortKey]));
  let favouriteView = $derived(activeSpaceId ?? section);
  let groupFavourites = $derived(groupsFavourites(favouriteView));
  let spaceRootItems = $derived(groupFavourites ? withoutFavourites(spaceTree) : spaceTree);
  let listedRooms = $derived.by<RoomNavRow[]>(() => {
    if (directSection) {
      return roomList.rooms
        .filter((room) => room.state === 'joined' && room.is_direct && !room.is_tombstoned)
        .map(roomRow)
        .sort(compareRooms);
    }

    if (pathname.startsWith('/space')) {
      return spaceTree.filter((item): item is SpaceTreeRoom => item.kind === 'room');
    }

    const claimedByJoinedSpace = unspacedSection
      ? claimedRoomIds(roomList.rooms)
      : new Set<string>();

    return roomList.rooms
      .filter(
        (room) =>
          room.state === 'joined' &&
          !room.is_tombstoned &&
          room.room_kind !== 'space' &&
          !(unspacedSection && room.is_direct) &&
          !claimedByJoinedSpace.has(room.room_id)
      )
      .map(roomRow)
      .sort(compareRooms);
  });
  let favourites = $derived.by<RoomNavRow[]>(() => {
    if (!groupFavourites) return [];
    const rows = pathname.startsWith('/space') ? treeRows(spaceTree) : listedRooms;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this derivation
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (!isFavourite(row) || seen.has(row.roomId)) return false;
        seen.add(row.roomId);
        return true;
      })
      .map((row) => ({ ...row, depth: 0, key: row.roomId }))
      .sort(compareRooms);
  });
  let rooms = $derived(
    groupFavourites ? listedRooms.filter((row) => !isFavourite(row)) : listedRooms
  );
  let sectionRooms = $derived([...favourites, ...rooms]);
  let invites = $derived.by<RoomListItemView[]>(() => {
    const pending = roomList.rooms.filter(
      (room) =>
        room.state === 'invited' &&
        !isDeclining(room.room_id) &&
        !dismissedInvites.has(room.room_id)
    );

    if (directSection) {
      return pending.filter((room) => room.is_direct);
    }

    if (pathname.startsWith('/space')) {
      const children = new Set(activeSpace?.space_children.map((child) => child.room_id) ?? []);
      return pending.filter((room) => children.has(room.room_id));
    }

    const claimedByJoinedSpace = unspacedSection
      ? claimedRoomIds(roomList.rooms)
      : new Set<string>();

    return pending.filter(
      (room) => !(unspacedSection && room.is_direct) && !claimedByJoinedSpace.has(room.room_id)
    );
  });
  $effect(() => {
    publishVisibleRoomOrder(sectionRooms.map((row) => row.roomId));
  });
  let calendarRooms = $derived(
    spaceTree
      .filter((item): item is SpaceTreeRoom => item.kind === 'room')
      .map((item) => item.room)
      .filter((room) => room.room_kind === 'calendar')
  );
  let subspaces = $derived(spaceRootItems.filter((item) => item.kind !== 'room'));
  let visibleSubspaces = $derived<RoomNavItem[]>(
    flattenSpaceTree(subspaces, {
      closed: (key) => closedCategories.has(key),
      keep: stillShownRow,
    })
  );
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

    return resolve('/(app)/home/[roomId]', { roomId: routeId });
  }

  function notificationChip(mode: NotificationModeView): { icon: Component; label: string } {
    if (mode === 'mute') return { icon: BellSlashIcon, label: 'room.notifyMute' };
    if (mode === 'mentions') return { icon: BellIcon, label: 'room.notifyMentions' };

    return { icon: BellRingingIcon, label: 'room.notifyAll' };
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
      core.rpc.timeline,
      readReceiptIsPrivate()
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
    {title}
    titleIcon={TitleIcon}
    {collapsed}
    menuItems={listMenuItems}
  />

  {#snippet listMenuItems()}
    <ActionMenuItem disabled={!sectionUnread} onSelect={markSectionRead}>
      <ChecksIcon />
      {i18n.t('common.markAsRead')}
    </ActionMenuItem>
    <ActionMenuItem
      closeOnSelect={false}
      checked={groupFavourites}
      onSelect={() => {
        setGroupsFavourites(favouriteView, !groupFavourites);
      }}
    >
      <span class="menu-check" aria-hidden="true">{groupFavourites ? '✓' : ''}</span>
      <span>{i18n.t('nav.groupFavourites')}</span>
    </ActionMenuItem>
    <ActionMenuSeparator />
    {#if !activeSpace}
      {#each ROOM_SORTS as option (option)}
        <ActionMenuItem
          checked={preferences[sortKey] === option}
          onSelect={() => {
            setPreference(sortKey, option);
          }}
        >
          <span class="menu-check" aria-hidden="true"
            >{preferences[sortKey] === option ? '✓' : ''}</span
          >
          <span>{i18n.t(ROOM_SORT_LABELS[option])}</span>
        </ActionMenuItem>
      {/each}
    {:else}
      <ActionMenuItem
        onSelect={() => {
          openSettings(activeSpace);
        }}
      >
        <GearIcon />
        {i18n.t('room.menuSettings')}
      </ActionMenuItem>
      <ActionMenuItem
        destructive
        onSelect={() => {
          openLeave(activeSpace);
        }}
      >
        <SignOutIcon />
        {i18n.t('room.menuLeaveSpace')}
      </ActionMenuItem>
    {/if}
  {/snippet}

  {#snippet threadLines(threads: readonly Thread[] | undefined)}
    {#if !collapsed && threads}
      {#each threads as thread (thread.level)}
        <span class="thread" style:--thread-level={thread.level} aria-hidden="true">
          {#if thread.kind !== 'last'}<span class="thread-line"></span>{/if}
          {#if thread.kind !== 'through'}<span class="thread-elbow"></span>{/if}
        </span>
      {/each}
    {/if}
  {/snippet}

  {#snippet optionsButton(room: RoomListItemView, parentSpaceId: string | null)}
    {@const open = optionsRoomId === room.room_id}
    <button
      type="button"
      class="room-options-trigger selection-open"
      aria-label={i18n.t('room.menuLabel')}
      aria-haspopup="menu"
      aria-expanded={open}
      data-state={open ? 'open' : 'closed'}
      onclick={(event) => {
        toggleOptionsMenu(event.currentTarget, room, parentSpaceId);
      }}
    >
      <DotsThreeVerticalIcon />
    </button>
  {/snippet}

  {#snippet navRoom(item: RoomNavRow, sectionClosed: boolean)}
    {@const room = item.room}
    {@const name = room ? roomLabel(room) : item.roomId}
    {@const avatarUrl = room ? roomAvatarUrl(room) : null}
    {@const href = roomHref(item)}
    {@const active = pathname === href}
    {@const counts = room ? roomList.badgeUnreadFor(room) : NO_UNREAD}
    {@const mentions = counts.highlight}
    {@const unread = counts.unread}
    {@const marked = counts.marked ?? false}
    {@const live = room?.call_participants.length ?? 0}
    {@const notifyMode = room ? roomList.notificationOverride(room.room_id) : null}
    {@const typing =
      !preferences.hideTypingIndicators &&
      room !== undefined &&
      roomList.typingUserIds(room.room_id).length > 0 &&
      mentions === 0 &&
      unread === 0 &&
      !marked}
    {@const peerId = room?.is_direct ? dmPeerId(room) : null}
    {@const peerPresence = peerId ? presenceStore.peek(peerId) : null}
    {@const peerStatus = peerId ? resolveUserStatus(peerProfiles.get(peerId), peerPresence) : null}
    {@const closed = sectionClosed && !(room !== undefined && (active || hasUnread(counts)))}
    <div class={['room-row-wrap', { 'closed-row': closed }]}>
      {@render threadLines(item.threads)}
      {#snippet roomTrigger({ props }: { props: Record<string, unknown> })}
        <!-- eslint-disable svelte/no-navigation-without-resolve -- roomHref() resolves the route itself -->
        <a
          {...props}
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
          aria-label={collapsed ? name : undefined}
          aria-current={active ? 'page' : undefined}
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
            <span class="room-text">
              <span class="room-name">{name}</span>
              {#if room?.is_direct && room.topic && preferences.showDmTopics}
                <span class="room-topic">{room.topic}</span>
              {:else if peerStatus}
                {@const peerStatusLabel = [peerStatus.emoji, peerStatus.text]
                  .filter(Boolean)
                  .join(' ')}
                <Tooltip label={peerStatusLabel}>
                  {#snippet trigger({ props })}
                    <span {...props} class="room-topic">
                      {#if peerStatus.emoji}<span class="room-status-emoji">{peerStatus.emoji}</span
                        >{/if}{peerStatus.text}
                    </span>
                  {/snippet}
                </Tooltip>
              {:else if room?.room_kind === 'calendar' && preferences.showSpaceEvents}
                <CalendarRowEvent roomId={room.room_id} />
              {/if}
            </span>
            {#if room && live > 0}
              {@const faces = room.call_participants.slice(0, MAX_VOICE_FACES)}
              {@const faceKeys = participantKeys(faces)}
              <span
                class="voice-live"
                role="img"
                aria-label={i18n.t('nav.voiceLive', { count: live })}
                {@attach whenVisible(() => {
                  for (const userId of faces) peerProfiles.request(userId);
                })}
              >
                <span class="voice-faces">
                  {#each faces as userId, index (faceKeys[index])}
                    {@const profile = peerProfiles.get(userId)}
                    <Avatar
                      class="voice-face"
                      src={profile?.avatar_url ?? null}
                      name={profile?.display_name ?? userId}
                      id={userId}
                    />
                  {/each}
                </span>
                <StatusBadge label={String(live)} variant="primary" />
              </span>
            {/if}
            <span class="room-status">
              {#if typing}
                <span class="room-typing"><TypingDots /></span>
              {:else}
                <UnreadBadge
                  {counts}
                  dm={room?.is_direct ?? false}
                  role="img"
                  aria-label={mentions > 0
                    ? i18n.t('nav.unreadMentions', { count: mentions })
                    : unread > 0
                      ? i18n.t('nav.unreadMessages', { count: unread })
                      : i18n.t('nav.markedUnread')}
                />
              {/if}
              {#if notifyMode}
                {@const chip = notificationChip(notifyMode)}
                <span class="room-mode" role="img" aria-label={i18n.t(chip.label)}>
                  <chip.icon />
                </span>
              {/if}
            </span>
          {:else if !typing}
            <UnreadBadge
              class="room-collapsed-badge"
              {counts}
              dm={room?.is_direct ?? false}
              role="img"
              aria-label={mentions > 0
                ? i18n.t('nav.unreadMentions', { count: mentions })
                : unread > 0
                  ? i18n.t('nav.unreadMessages', { count: unread })
                  : i18n.t('nav.markedUnread')}
            />
          {/if}
        </a>
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
      {/snippet}
      {#if collapsed}
        <Tooltip label={name} side="right" trigger={roomTrigger} />
      {:else}
        {@render roomTrigger({ props: {} })}
        {#if room}
          <span class="room-options-slot">
            {#if room.room_kind === 'voice'}
              <button
                class="room-options-trigger"
                type="button"
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
    {#if room?.room_kind === 'voice' && live > 0}
      <CallParticipantList
        {room}
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
    {@const name = roomLabel(room)}
    {@const href = resolve('/(app)/space/[spaceId]/lobby', {
      spaceId: roomPathParam(room, roomList.rooms),
    })}
    {@const active = pathname === href}
    <div class="room-row-wrap">
      {@render threadLines(item.threads)}
      {#snippet linkTrigger({ props }: { props: Record<string, unknown> })}
        <a
          {...props}
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
              class={['room-avatar-icon', { glyph: !roomAvatarUrl(room) }]}
              id={roomAvatarUrl(room) ? room.room_id : null}
              src={roomAvatarUrl(room)}
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
            <span class="room-text"><span class="room-name">{name}</span></span>
            <span class="room-link-icon" aria-hidden="true"><SquaresFourIcon /></span>
          {/if}
        </a>
      {/snippet}
      {#if collapsed}
        <Tooltip label={name} side="right" trigger={linkTrigger} />
      {:else}
        {@render linkTrigger({ props: {} })}
        <span class="room-options-slot">
          {@render optionsButton(room, null)}
        </span>
      {/if}
    </div>
  {/snippet}

  <div class="room-nav-content">
    <RoomNavActions {pathname} {activeSpace} {collapsed} {onNavigate} />

    {#if !collapsed && activeSpace && preferences.showSpaceEvents && calendarRooms.length > 0}
      <SpaceEvents
        spaceId={roomPathParam(activeSpace, roomList.rooms)}
        rooms={calendarRooms}
        {onNavigate}
      />
    {/if}

    <RoomInvites {collapsed} {invites} />

    {#if favourites.length > 0}
      {#if !collapsed}
        <button
          type="button"
          class="rooms-heading selection-layer"
          aria-expanded={!favouritesClosed}
          data-state={favouritesClosed ? 'closed' : 'open'}
          aria-controls={favouritesListId}
          onclick={() => {
            favouritesClosed = !favouritesClosed;
          }}
        >
          <span class="rooms-heading-label">{i18n.t('nav.favourites')}</span>
          <span class={['category-caret', { closed: favouritesClosed }]} aria-hidden="true"
            ><CaretDownIcon /></span
          >
        </button>
      {/if}
      <div id={favouritesListId} class={['room-list favourites', { collapsed }]}>
        {#each favourites as item (item.key)}
          {@render navRoom(item, favouritesClosed)}
        {/each}
      </div>
    {/if}

    {#if !collapsed}
      <button
        type="button"
        class="rooms-heading selection-layer"
        aria-expanded={!roomsClosed}
        data-state={roomsClosed ? 'closed' : 'open'}
        aria-controls={roomListId}
        onclick={() => {
          roomsClosed = !roomsClosed;
        }}
      >
        <span class="rooms-heading-label">{listLabel}</span>
        <span class={['category-caret', { closed: roomsClosed }]} aria-hidden="true"
          ><CaretDownIcon /></span
        >
      </button>
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
          {#each rooms as item (item.key)}
            {@render navRoom(item, roomsClosed)}
          {/each}
          {#each visibleSubspaces as item (item.key)}
            {#if item.kind === 'category'}
              {@const name = roomLabel(item.room)}
              {@const isClosed = closedCategories.has(item.key)}
              <div class="room-row-wrap">
                {@render threadLines(item.threads)}
                {#snippet categoryTrigger({ props }: { props: Record<string, unknown> })}
                  <button
                    {...props}
                    type="button"
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
                    {#if !collapsed}<span class="category-name">{name}</span>{/if}
                    <span class={['category-caret', { closed: isClosed }]} aria-hidden="true"
                      ><CaretDownIcon /></span
                    >
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

<LeaveRoomDialog
  open={leaveRoom !== null}
  room={leaveRoom}
  onOpenChange={(open) => {
    if (!open) leaveRoomId = null;
  }}
/>

{#if contextRoom}
  {@const fromTrigger = contextAnchor !== null && 'focus' in contextAnchor}
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
    />
  {/key}
{/if}

<style>
  .room-nav {
    background: var(--bg-container);
    border-right: var(--border-width) solid var(--bg-container-line);
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

  .category-caret {
    align-items: center;
    display: inline-flex;
    flex: 0 0 var(--icon-size-large);
    height: var(--icon-size-large);
    justify-content: center;
    line-height: 0;
    width: var(--icon-size-large);
  }

  @media (prefers-reduced-motion: no-preference) {
    .category-caret {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
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
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-100);
    height: var(--control-height-medium);
    margin-inline: var(--space-200);
    opacity: var(--opacity-p300);
    padding: 0 var(--space-200);
    text-align: left;
    width: calc(100% - var(--space-200) * 2);
  }

  .rooms-heading:focus-visible {
    background: var(--bg-container-hover);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .rooms-heading:hover {
      background: var(--bg-container-hover);
    }
  }

  .rooms-heading-label {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-500);
    margin: 0;
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
    margin-right: var(--space-100);
  }

  .room-status {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-100);
    justify-content: center;
  }

  .room-status:has(> *) {
    min-width: 1.5rem;
  }

  .room-status :global(.unread-badge-dot) {
    background-clip: content-box;
    padding-inline: var(--space-200);
    width: var(--space-600);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .room-row-wrap:not(:has(.room-status > *, .voice-live)):is(:hover, :focus-within) .room-row,
    .room-row-wrap:not(:has(.room-status > *, .voice-live)):has(
        :global(.room-options-trigger[data-state='open'])
      )
      .room-row {
      padding-right: calc(var(--space-100) + var(--space-600));
    }

    .room-options-slot {
      margin-right: var(--space-100);
      pointer-events: none;
      position: absolute;
      right: 0;
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

    .room-row-wrap:hover .room-status,
    .room-row-wrap:hover .voice-live,
    .room-row-wrap:focus-within .room-status,
    .room-row-wrap:focus-within .voice-live,
    .room-row-wrap:has(:global(.room-options-trigger[data-state='open'])) .room-status,
    .room-row-wrap:has(:global(.room-options-trigger[data-state='open'])) .voice-live {
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

  .room-list > .room-row-wrap:not(:focus-within, :has(.room-category)) {
    contain-intrinsic-size: auto 2.25rem;
    content-visibility: auto;
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

  .thread {
    display: contents;
  }

  .thread-line,
  .thread-elbow {
    border-color: var(--surface-container-line);
    border-style: solid;
    border-width: 0 0 0 var(--border-width-500);
    left: calc(
      var(--space-200) + var(--thread-level) * var(--space-400) + var(--space-400) / 2 -
        var(--border-width-500) / 2
    );
    pointer-events: none;
    position: absolute;
    top: 0;
  }

  .room-list
    > :where(:not(.closed-row))
    ~ .room-row-wrap:has(.room-category)
    :is(.thread-line, .thread-elbow) {
    top: calc(-1 * var(--space-300));
  }

  .thread-line {
    bottom: 0;
  }

  .thread-elbow {
    border-bottom-left-radius: var(--radii-300);
    border-bottom-width: var(--border-width-500);
    bottom: calc(50% - var(--border-width-500) / 2);
    width: calc(var(--space-400) / 2 - var(--space-050));
  }

  .room-link-icon {
    align-items: center;
    display: flex;
    flex: none;
    opacity: var(--opacity-p300);
    padding-right: var(--space-100);
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
    text-align: left;
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

  .room-status-emoji {
    margin-right: var(--space-050);
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
    background: var(--sec-container);
    border: var(--border-width) solid var(--sec-container-line);
    border-radius: var(--radius-pill);
    height: 1.25rem;
    padding: 0 var(--space-150);
  }

  .room-mode {
    justify-content: center;
    opacity: var(--opacity-p300);
    width: var(--space-600);
  }

  .room-mode :global(svg) {
    height: var(--size-x200);
    width: var(--size-x200);
  }

  :global(.room-avatar-icon.voice) {
    font-size: var(--font-size-body);
  }

  .voice-live {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-100);
  }

  .voice-faces {
    display: flex;
  }

  .voice-faces :global(.avatar-root.voice-face) {
    --avatar-size: 1.25rem;

    border: var(--border-width) solid var(--bg-container);
  }

  .voice-faces :global(.avatar-root.voice-face:not(:first-child)) {
    margin-left: calc(-1 * var(--space-150));
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
    position: relative;
    width: var(--avatar-size-small);
  }

  .room-list.collapsed .room-row :global(.room-collapsed-badge) {
    position: absolute;
    right: 0.125rem;
    top: 0.125rem;
  }

  .room-list.collapsed .room-category {
    flex: none;
    justify-content: center;
    margin: 0 auto;
    padding: 0;
    width: var(--avatar-size-small);
  }

  :is(.room-category, .rooms-heading):focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  @media (--app-layout) {
    .room-nav {
      flex: 0 0 var(--room-nav-width);
      width: var(--room-nav-width);
    }

    .rooms-heading {
      height: var(--control-height-small);
    }

    .room-row {
      min-height: 2.25rem;
    }

    .room-category {
      min-height: 2rem;
    }
  }
</style>
