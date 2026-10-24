<script lang="ts">
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import { matrixLinkAction } from '#lib/rooms/matrix-link.js';
  import { MediaQuery } from 'svelte/reactivity';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import type { RoomListItemView, PerMessageProfileView } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { setPageState } from '#lib/platform/page-state.js';
  import { page } from '$app/state';

  import { voiceChat } from '#lib/features/room/voice-chat.svelte.js';

  import { useCoreClient } from '#lib/core/context.js';
  import { ancestorSpaceIds } from './abbreviations';
  import {
    abbreviationChanges,
    provideRoomAbbreviations,
    RoomAbbreviations,
  } from './room-abbreviations.svelte.js';
  import { provideRoomMemberNames } from './members/room-member-names.js';
  import { notifiedRelation } from './messages/notified-relation.js';
  import { PinnedEvents, providePinnedEvents } from './timeline/pinned-events.svelte.js';
  import { useBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import ConversationComposer from './conversation/ConversationComposer.svelte';
  import InlineEdit from './conversation/InlineEdit.svelte';
  import { Conversation } from './conversation/conversation.svelte.js';
  import { personaSpaces } from '#lib/features/composer/persona-spaces.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops, holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { matrixLinkPath, copyRoomLink, roomSectionPath } from '#lib/rooms/permalink.js';
  import { backToRoomList, searchInRoom, trackRoomEntry } from './room-navigation.js';
  import { findRoomByPathId, roomLabel, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
  import { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import { provideRoomCosmetics, RoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { activeRoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import ScheduledMessages from '#lib/features/composer/ScheduledMessages.svelte';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { composerClearance } from '#lib/ui/composer-clearance.svelte.js';
  import { PanelWidth } from '#lib/ui/panel-width.svelte.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { preferences, readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import VoiceLobby from '#lib/features/call/VoiceLobby.svelte';
  import { useCallSession, type CallMedia } from '#lib/features/call/call-session.svelte.js';
  import {
    provideRoomMediaPreviews,
    RoomMediaPreviews,
  } from './media/room-media-previews.svelte.js';
  import ThreadView from './conversation/ThreadView.svelte';
  import MentionProfile from './members/MentionProfile.svelte';
  import RoomHeader from './RoomHeader.svelte';
  import RoomHeaderActions from './RoomHeaderActions.svelte';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import RoomHeaderMenu from './RoomHeaderMenu.svelte';
  import { canSendState } from './settings/permission-groups';
  import RoomPinMenu from './RoomPinMenu.svelte';
  import RoomPredecessorNotice from './RoomPredecessorNotice.svelte';
  import RoomTombstoneBanner from './RoomTombstoneBanner.svelte';
  import RoomReadReceipts from './timeline/RoomReadReceipts.svelte';
  import TimelineList from './timeline/TimelineList.svelte';
  import type { MediaItem } from './media/media-viewer-types.js';
  import RoomMediaViewerDialog from './media/RoomMediaViewerDialog.svelte';
  import { galleryEventId } from './media/media-items.js';
  import { provideMediaViewerOpener } from './media/media-viewer-opener.svelte.js';
  import { tagForLevel } from './settings/power-level-tags.js';
  import { memberListChanges } from './settings/member-list.svelte.js';
  import { provideSenderRoles, type SenderRole } from './members/sender-roles.js';
  import { powerTag } from './members/power-tags';
  import { splitVia } from '#lib/rooms/join-address.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { eventBefore } from '#lib/model/model.js';
  import { RoomSession } from './room-session.svelte.js';
  import { MemberProfile } from './members/member-profile.svelte.js';
  import { RoomPanels } from './room-panels.svelte.js';
  import { RoomMediaViewer } from './room-media-viewer.svelte.js';
  import { TombstoneJoin } from './room-tombstone-join.svelte.js';
  import RoomCallStage from './RoomCallStage.svelte';
  import RoomVoiceChat from './RoomVoiceChat.svelte';
  import RoomSidePanels from './RoomSidePanels.svelte';
  import RoomDialogs from './RoomDialogs.svelte';
  import { RoomCallSupport } from './room-call-support.svelte.js';
  import { refreshRoomMembers } from './room-member-refresh.svelte.js';

  interface Props {
    roomId: string;
    eventId?: string | null;
    notifiedEventId?: string | null;
    room?: RoomListItemView;
  }

  let { roomId, eventId = null, notifiedEventId = null, room }: Props = $props();
  const core = useCoreClient();
  const panels = new RoomPanels();
  const memberProfile = new MemberProfile(core);
  onDestroy(() => memberProfile.close());
  trackRoomEntry();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const timelineOwner = Symbol('room-view');
  const activeTimeline = activeRoomTimeline();
  const timeline = activeTimeline.timeline;
  const memberLoader = new RoomMemberLoader();
  const call = useCallSession();
  let prescreenMedia = $derived<CallMedia>({
    microphone: !preferences.callMicrophoneMuted,
    camera: false,
  });
  let composer = $state<ConversationComposer>();
  let timelineList = $state<TimelineList>();
  let receiptsOpen = $state(false);
  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId) ?? room);
  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  const conversation = new Conversation({
    core,
    personas,
    timeline,
    roomId: () => resolvedRoomId,
    spaceIds: (id) => personaSpaces(roomList.rooms, id, page.params.spaceId).order,
    encrypted: () => resolvedRoom?.encrypted ?? null,
    beforeSend: () => timelineList?.resumeLive() ?? resumeLive(),
  });
  let settingsOpen = $state(false);
  let topicOpen = $state(false);
  let inviteOpen = $state(false);
  let jumpOpen = $state(false);
  let leaveOpen = $state(false);
  let reportOpen = $state(false);
  let timelineAtBottom = $derived.by(() => {
    void roomId;
    return eventId === null;
  });
  let timelineFollowingLive = $state<boolean>(false);
  const mediaViewer = new RoomMediaViewer(() => timeline.items);

  const callSupport = new RoomCallSupport(core, () => resolvedRoomId);

  let pinRevision = $derived(
    timeline.items.reduce(
      (count, item) =>
        item.content.kind === 'state_event' && item.content.change?.kind === 'pinned_events'
          ? count + 1
          : count,
      0
    )
  );

  const pinnedEvents = new PinnedEvents(core.rpc.timeline);
  const roomSession = new RoomSession(core.rpc, pinnedEvents);
  providePinnedEvents(pinnedEvents);
  onDestroy(() => roomSession.dispose());
  const tombstoneJoin = new TombstoneJoin(
    core.rpc,
    roomList,
    () => resolvedRoomId,
    () => isTombstoned,
    roomSession
  );

  $effect(() => {
    if (pinRevision === 0) return;
    const target = resolvedRoomId;
    if (target) void pinnedEvents.load(target);
  });

  const bookmarks = useBookmarks();

  let threadEventId = $state<string | null>(null);

  function openThread(rootEventId: string, targetEventId: string | null = null): void {
    threadEventId = targetEventId;
    panels.openThread(rootEventId);
  }

  function publishComposerClearance(node: HTMLElement): () => void {
    const update = (): void => {
      composerClearance.px = Math.max(0, window.innerHeight - node.getBoundingClientRect().top);
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const stopResize = on(window, 'resize', update);
    return () => {
      observer.disconnect();
      stopResize();
      composerClearance.px = 0;
    };
  }

  holdOverlayBack(() => panels.threadRootId !== null, closeThread);

  function closeThread(): void {
    panels.threadRootId = null;
    threadEventId = null;
  }

  let permalinkTarget = $state<{
    roomId: string;
    eventId: string;
    rootEventId: string | null;
  } | null>(null);

  $effect(() => {
    const targetEventId = eventId;
    const targetRoomId = resolvedRoomId;
    if (targetEventId === null) return;
    let active = true;
    void core.rpc.timeline
      .eventSource({ room_id: targetRoomId, event_id: targetEventId, include_original: false })
      .then(({ source }) => {
        if (!active) return;
        const relation = notifiedRelation(source);
        const rootEventId = relation?.thread ? relation.eventId : null;
        permalinkTarget = { roomId: targetRoomId, eventId: targetEventId, rootEventId };
        if (rootEventId !== null) openThread(rootEventId, targetEventId);
        else closeThread();
      })
      .catch((error: unknown) => {
        if (!active) return;
        permalinkTarget = { roomId: targetRoomId, eventId: targetEventId, rootEventId: null };
        closeThread();
        console.debug('[sable room] linked event unavailable', error);
      });
    return () => {
      active = false;
    };
  });

  let notifiedTarget = $state<{ eventId: string; target: string } | null>(null);
  let landingEventId = $derived(
    notifiedTarget !== null && notifiedTarget.eventId === notifiedEventId
      ? notifiedTarget.target
      : notifiedEventId
  );
  $effect(() => {
    const eventId = notifiedEventId;
    const target = resolvedRoomId;
    if (eventId === null) return;
    let active = true;
    core.rpc.timeline
      .eventSource({ room_id: target, event_id: eventId, include_original: false })
      .then(({ source }) => {
        const relation = notifiedRelation(source);
        if (!active || relation === null) return;
        notifiedTarget = { eventId, target: relation.eventId };
        if (relation.thread) openThread(relation.eventId, eventId);
      })
      .catch((error: unknown) => {
        console.debug('[sable room] notified event unavailable', error);
      });
    return () => {
      active = false;
    };
  });
  onMount(() => {
    void bookmarks.load();
  });
  let showReceiptFooter = $derived(
    !preferences.hideReadReceipts && preferences.readReceiptPlacement === 'room'
  );
  let latestReceiptItem = $derived.by(() => {
    if (!showReceiptFooter) return null;
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if (!item.event_id) continue;
      return item;
    }
    return null;
  });
  let latestReadBy = $derived(
    latestReceiptItem?.read_by.filter((readerId) => readerId !== core.session?.user_id) ?? []
  );
  let receiptMembers = $derived(
    memberLoader.members.filter((member) => latestReadBy.includes(member.user_id))
  );

  onDestroy(() => {
    void activeTimeline.stop(timelineOwner);
  });

  let callParticipants = $derived(resolvedRoom?.call_participants ?? []);
  let callable = $derived(
    !call.active &&
      callSupport.current !== null &&
      callSupport.current.can_join &&
      (callSupport.current.has_focus || callParticipants.length > 0)
  );
  let callOffered = $derived(
    callable &&
      ((resolvedRoom?.is_direct ?? false) ||
        callParticipants.length > 0 ||
        preferences.alwaysShowCallButton ||
        memberLoader.members.length <= 10)
  );

  let composerMounted = $state(false);
  $effect(() => {
    if (composerMounted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        composerMounted = true;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  });
  let resolvedPermalink = $derived(
    permalinkTarget?.roomId === resolvedRoomId && permalinkTarget.eventId === eventId
      ? permalinkTarget
      : null
  );
  let timelineEventId = $derived(resolvedPermalink?.rootEventId ?? eventId);
  const sidePanels = new MediaQuery(BREAKPOINTS.sidePanels);
  const callStageRatio = new PanelWidth(
    'sable-call-stage-ratio',
    sidePanels.current ? 0.65 : 0.4,
    0.2,
    0.8
  );
  callStageRatio.restore();
  let timelineHeight = $state(0);
  let isVoiceRoom = $derived(resolvedRoom?.room_kind === 'voice');
  const voiceChatWidth = new PanelWidth('sable-voice-chat-width', 400, 300, 1000);
  voiceChatWidth.restore();
  let callShown = $derived(call.roomId === resolvedRoomId && (call.active || call.failure));
  let roomName = $derived(resolvedRoom ? roomLabel(resolvedRoom) : roomId);
  let roomAvatar = $derived(resolvedRoom?.avatar_url ?? null);
  let roomTopic = $derived(resolvedRoom?.topic ?? null);
  let isTombstoned = $derived(resolvedRoom?.is_tombstoned ?? false);

  const abbreviations = new RoomAbbreviations(core.rpc);
  provideRoomAbbreviations(abbreviations);
  const mediaPreviews = new RoomMediaPreviews(() => resolvedRoom?.join_rule ?? null);
  provideRoomMediaPreviews(mediaPreviews);
  provideMediaViewerOpener((item) => mediaViewer.openStandalone(item));
  $effect(() => {
    void mediaPreviews.load(resolvedRoomId);
  });
  provideRoomMemberNames({ displayName: memberDisplayName });
  let senderRoles = $derived.by((): Record<string, SenderRole> => {
    const tags = roomSession.powerTags;
    if (!tags) return {};
    return Object.fromEntries(
      memberLoader.members.flatMap((member) => {
        const tag = tagForLevel(tags, member.power_level);
        const icon = tag?.icon ?? null;
        const color = powerTag(member.power_level, i18n.t, tags).color;
        return icon || color ? [[member.user_id, { icon, name: tag?.name ?? null, color }]] : [];
      })
    );
  });
  provideSenderRoles((userId) => senderRoles[userId] ?? null);

  const cosmetics = new RoomCosmetics(core);
  provideRoomCosmetics(cosmetics);
  let routeSpace = $derived(findRoomByPathId(roomList.rooms, page.params.spaceId));
  let cosmeticsSpaceId = $derived(
    routeSpace?.space_children.some((child) => child.room_id === resolvedRoomId)
      ? routeSpace.room_id
      : null
  );

  onMount(() => cosmetics.watch());

  $effect(() => {
    void cosmetics.load(resolvedRoomId, cosmeticsSpaceId);
  });

  let ancestorSpaceKey = $derived(ancestorSpaceIds(roomList.rooms, resolvedRoomId).join(','));

  $effect(() => {
    void abbreviationChanges.version;
    const key = ancestorSpaceKey;
    void abbreviations.load(resolvedRoomId, key === '' ? [] : key.split(','));
  });
  let mentionCount = $derived(
    roomList.rooms
      .filter((room) => room.state === 'joined' && room.room_kind !== 'space')
      .reduce((total, room) => total + roomList.notificationsFor(room).highlight, 0)
  );
  let pageTitle = $derived(
    mentionCount > 0 ? `(${mentionCount}) ${roomName} - Sable` : `${roomName} - Sable`
  );
  const appLayout = new AppLayout();
  let phone = $derived(!appLayout.current);
  let pinsOpen = $state(false);
  let pinsUnread = $state(0);
  let desktop = $derived(sidePanels.current);
  let threadInPanel = $derived(desktop && preferences.threadPresentation === 'panel');
  let voiceView = $derived(isVoiceRoom && (!voiceChat.open || desktop));
  let voiceChatBeside = $derived(isVoiceRoom && voiceChat.open && desktop);
  let typingUserIds = $derived(roomList.typingUserIds(resolvedRoomId));
  let typingUsers = $derived(
    preferences.hideTypingIndicators
      ? []
      : typingUserIds.map((userId) => ({ userId, name: memberDisplayName(userId) }))
  );

  $effect(() => {
    void resolvedRoomId;
    memberLoader.reset();
    untrack(() => conversation.followRoom());
    receiptsOpen = false;
    panels.reset();
    closeProfile();
  });

  $effect(() => {
    roomSession.sync(resolvedRoomId, isTombstoned, memberListChanges.version);
  });

  let canManageWidgets = $derived(
    canSendState(
      roomSession.powerLevels,
      roomSession.permissions?.own_power_level ?? 0,
      'im.vector.modular.widgets'
    )
  );

  $effect(() => {
    if (desktop && panels.desktopMembersOpen) void loadMembers();
  });

  // Returning to live drops the anchor from the URL.
  /** The `?event=` the effect below has handed to the timeline. */
  let appliedEventId: string | null = null;
  let openedRoomId: string | null = null;
  let timelineRoomId = $derived(resolvedRoom?.room_id);
  let roomHasUnread = $derived(
    (resolvedRoom?.unread ?? 0) > 0 ||
      (resolvedRoom?.highlight ?? 0) > 0 ||
      (resolvedRoom?.marked_unread ?? false)
  );

  $effect(() => {
    // A jump restarts the timeline asynchronously, so wait for the target to be applied.
    if (eventId === null || eventId !== appliedEventId) return;
    if (resolvedPermalink === null || resolvedPermalink.rootEventId !== null) return;
    if (!timelineFollowingLive || timeline.mode.kind !== 'live') return;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- rewrites the query of the current, already resolved URL
    void goto(roomUrl(null), { replace: true, reset: false });
  });

  $effect(() => {
    const activeRoomId = timelineRoomId;
    if (!activeRoomId) return;
    const targetEventId = timelineEventId;
    // A linked event may sit in a thread, so its place is known only once it is resolved.
    if (eventId !== null && resolvedPermalink === null) return;
    const anchor = untrack(() => {
      // A loaded event is reached by scrolling, but only while live.
      const loaded = timeline.items.some((item) => item.event_id === targetEventId);
      return loaded && timeline.mode.kind === 'live' ? null : targetEventId;
    });
    appliedEventId = eventId;
    const openAtUnread = untrack(() => {
      if (openedRoomId === activeRoomId) return false;
      openedRoomId = activeRoomId;
      return (
        eventId === null &&
        notifiedEventId === null &&
        roomHasUnread &&
        preferences.openRoomsAtUnread
      );
    });
    // Read outside `untrack`: the toggle only takes effect by re-subscribing.
    const hiddenEvents = preferences.showHiddenEvents;
    void untrack(() =>
      activeTimeline.start(
        timelineOwner,
        activeRoomId,
        anchor,
        hiddenEvents,
        openAtUnread,
        landingEventId,
        resolvedRoom === undefined || roomHasUnread
      )
    );
    void untrack(() => loadMembers());
  });

  async function loadMembers(): Promise<void> {
    const activeRoomId = resolvedRoomId;
    await memberLoader.load(activeRoomId, (roomId) =>
      core.rpc.members.list({ room_id: roomId, memberships: [] })
    );
  }

  refreshRoomMembers(core, memberLoader, () => resolvedRoomId);

  function toggleMembers(): void {
    if (panels.toggleMembers(desktop)) void loadMembers();
  }

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    return core.subscribeEvents((event) => {
      if (event.type === 'room_widgets_changed' && event.room_id === activeRoomId) {
        roomSession.details.refreshWidgets().catch((error: unknown) => {
          console.debug('[sable room] widgets unavailable', error);
        });
      }
    });
  });

  function toggleWidgets(): void {
    panels.toggleWidgets();
  }

  function closeProfile(): void {
    memberProfile.close();
  }

  function mentionUser(userId: string, name: string): void {
    composer?.insertMention(userId, name);
  }

  function openProfile(
    userId: string,
    anchor: HTMLElement,
    pmp?: PerMessageProfileView | null
  ): void {
    if (pmp) {
      memberProfile.showPmp(userId, anchor, pmp);
    } else {
      void loadMembers();
      void memberProfile.show(userId, anchor);
    }
  }

  function handleMatrixLink(link: MatrixLink, anchor: HTMLAnchorElement): void {
    if (matrixLinkAction(anchor.href, link) !== null) {
      const target = matrixLinkPath(anchor.href);
      if (target !== null) {
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- matrixLinkPath resolves the permalink route
        void afterOverlayPops().then(() => goto(target));
      }
      return;
    }
    if (link.kind === 'user') {
      openProfile(link.user_id, anchor);
      return;
    }

    // The href carries `?via=` inside the fragment, which the parsed link drops.
    const { via } = splitVia(anchor.href);
    const target = roomSectionPath(
      roomList.rooms,
      link.room_id,
      link.kind === 'event' ? link.event_id : null,
      via
    );
    if (link.kind === 'event' && target === `${page.url.pathname}${page.url.search}`) {
      jumpToEvent(link.event_id);
      return;
    }
    void afterOverlayPops().then(() =>
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
      goto(target, {
        replace: phone && new URL(target, page.url.href).pathname === page.url.pathname,
      })
    );
  }

  function handleProfileLink(link: MatrixLink, anchor: HTMLAnchorElement): void {
    if (
      link.kind === 'user' &&
      memberProfile.anchor &&
      matrixLinkAction(anchor.href, link) === null
    ) {
      openProfile(link.user_id, memberProfile.anchor);
      return;
    }
    handleMatrixLink(link, anchor);
  }

  function copyEventLink(eventId: string): void {
    void writeEventLink(eventId);
  }

  async function writeEventLink(eventId: string): Promise<void> {
    const room = {
      room_id: resolvedRoomId,
      canonical_alias: resolvedRoom?.canonical_alias ?? null,
    };
    if (!(await copyRoomLink(core, room, eventId))) toasts.error(i18n.t('errors.copyFailed'));
  }

  function memberDisplayName(userId: string): string | null {
    const known = memberLoader.members.find((member) => member.user_id === userId)?.display_name;
    return profileOverrides.of(userId)
      ? profileOverrides.name(userId, known ?? userId)
      : (known ?? null);
  }

  /** RoomPage is mounted by the home, direct and space routes alike, so the
      current path has to survive the rewrite. */
  function roomUrl(eventId: string | null): string {
    const url = new URL(page.url.href);
    if (eventId === null) url.searchParams.delete('event');
    else url.searchParams.set('event', eventId);
    return `${url.pathname}${url.search}`;
  }

  function landed(): void {
    if (notifiedEventId === null) return;
    void setPageState({ ...page.state, notified: undefined }, true);
  }

  function jumpToLive(): void {
    void activeTimeline.start(timelineOwner, resolvedRoomId, null, preferences.showHiddenEvents);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- rewrites the query of the current, already resolved URL
    void goto(roomUrl(null), { replace: true });
  }

  function jumpToEvent(eventId: string): void {
    if (eventId === page.url.searchParams.get('event')) {
      if (!timelineList?.jumpToEvent(eventId)) {
        void activeTimeline.start(
          timelineOwner,
          resolvedRoomId,
          eventId,
          preferences.showHiddenEvents
        );
      }
      return;
    }
    const target = roomUrl(eventId);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- rewrites the query of the current, already resolved URL
    void afterOverlayPops().then(() => goto(target, { replace: phone, reset: false }));
  }

  function requestHistory(count = 25): Promise<boolean> {
    return timeline.paginateBackward(count);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  async function markRead(eventId: string, fullyRead: boolean): Promise<void> {
    await core.rpc.timeline.markRead({
      room_id: resolvedRoomId,
      event_id: eventId,
      private_receipt: readReceiptIsPrivate(),
      thread_root: null,
      subscription: timeline.subscriptionId,
      fully_read: fullyRead,
    });
  }

  function setFullyRead(roomId: string, eventId: string): void {
    void core.rpc.timeline
      .setFullyRead({ room_id: roomId, event_id: eventId })
      .catch((error: unknown) => {
        console.warn('[sable room] moving the read marker failed', error);
      });
  }

  function markUnreadFrom(eventId: string): void {
    void core.rpc.timeline
      .markUnread({
        room_id: resolvedRoomId,
        read_marker: eventBefore(
          timeline.items.map((item) => item.event_id),
          eventId
        ),
      })
      .catch((error: unknown) => {
        console.warn('[sable room] mark as unread failed', error);
        toasts.error(i18n.t('errors.actionFailed'));
      });
  }

  function markRoomRead(): void {
    void markAllRead().catch((error: unknown) => {
      console.warn('[sable room] mark as read failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    });
  }

  async function markAllRead(): Promise<void> {
    const list = timelineList;
    await core.rpc.timeline.markRead({
      room_id: resolvedRoomId,
      event_id: null,
      private_receipt: readReceiptIsPrivate(),
      thread_root: null,
      subscription: null,
      fully_read: false,
    });
    list?.dismissUnread();
  }

  function requestUnread(eventId: string): Promise<void> {
    return activeTimeline.startUnread(
      timelineOwner,
      resolvedRoomId,
      eventId,
      preferences.showHiddenEvents
    );
  }

  function resumeLive(): Promise<void> {
    return activeTimeline.resumeLive(timelineOwner);
  }

  function markRoomUnread(): void {
    void core.rpc.timeline
      .markUnread({ room_id: resolvedRoomId, read_marker: null })
      .catch((error: unknown) => {
        console.warn('[sable room] mark as unread failed', error);
        toasts.error(i18n.t('errors.actionFailed'));
      });
  }

  function openMedia(eventId: string): void {
    mediaViewer.open(eventId);
  }

  function openPanelMedia(items: MediaItem[], eventId: string): void {
    mediaViewer.openPanel(items, eventId);
  }

  function jumpFromViewer(eventId: string): void {
    mediaViewer.close();
    if (!desktop) panels.attachmentsOpen = false;
    void afterOverlayPops().then(() => {
      jumpToEvent(galleryEventId(eventId));
    });
  }

  function toggleThreads(): void {
    panels.toggleThreads();
  }

  function toggleAttachments(): void {
    panels.toggleAttachments();
  }

  function openSearch(): void {
    if (!desktop) {
      searchInRoom(resolvedRoom, resolvedRoomId);
      return;
    }
    panels.toggleSearch();
  }

  function openProfileAvatar(source: string, displayName: string): void {
    closeProfile();
    mediaViewer.openProfile(source, displayName);
  }

  function openPredecessor(): void {
    if (!roomSession.predecessor) return;
    void goto(
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
      roomSectionPath(
        roomList.rooms,
        roomSession.predecessor.room_id,
        null,
        roomSession.predecessor.via
      )
    );
  }

  function startCall(): void {
    call.clearFailure();
    void call.join(
      resolvedRoomId,
      { microphone: !preferences.callMicrophoneMuted, camera: false },
      callSupport.fallbackUrl
    );
  }

  function joinCall(): void {
    void call.join(resolvedRoomId, prescreenMedia, callSupport.fallbackUrl);
  }
</script>

<PageTitle title={pageTitle} />

{#snippet inlineEditor()}
  <InlineEdit {conversation} roomId={resolvedRoomId} />
{/snippet}

{#snippet predecessorNotice()}
  <RoomPredecessorNotice onOpen={openPredecessor} />
{/snippet}

{#snippet chat()}
  {#key resolvedRoomId}
    <TimelineList
      bind:this={timelineList}
      replyEventId={conversation.context?.kind === 'reply' ? conversation.context.eventId : null}
      editEventId={conversation.context?.kind === 'edit' ? conversation.context.eventId : null}
      inlineEditor={conversation.inlineEdit ? inlineEditor : undefined}
      {timeline}
      active={panels.threadRootId === null || threadInPanel}
      focusEventId={timelineEventId}
      {landingEventId}
      onLanded={landed}
      onRequestHistory={requestHistory}
      onRequestFuture={requestFuture}
      onRead={markRead}
      onFullyRead={setFullyRead}
      hasUnread={resolvedRoom === undefined || roomHasUnread}
      onRequestUnread={requestUnread}
      onResumeLive={resumeLive}
      onMarkRead={markAllRead}
      onMarkUnread={markUnreadFrom}
      onMatrixLink={handleMatrixLink}
      onCopyLink={copyEventLink}
      onSenderProfile={openProfile}
      onMentionUser={mentionUser}
      onRetrySend={conversation.retrySend}
      onCancelSend={conversation.cancelSend}
      onToggleReaction={roomSession.permissions?.can_react === false
        ? undefined
        : conversation.toggleReaction}
      onDelete={conversation.redact}
      onReply={roomSession.permissions?.can_post === false ? undefined : conversation.reply}
      onCancelContext={conversation.clearContext}
      onOpenThread={openThread}
      onEdit={roomSession.permissions?.can_post === false ? undefined : conversation.edit}
      roomId={resolvedRoomId}
      members={memberLoader.members}
      onJumpToEvent={jumpToEvent}
      onJumpToLive={jumpToLive}
      onOpenMedia={openMedia}
      onVotePoll={conversation.votePoll}
      onEndPoll={conversation.endPoll}
      readOnly={roomSession.permissions ? !roomSession.permissions.can_post : false}
      canRedactOwn={roomSession.permissions?.can_redact_own ?? true}
      canRedactOthers={roomSession.permissions?.can_redact_others ?? false}
      canPin={roomSession.permissions?.can_pin ?? false}
      encrypted={resolvedRoom?.encrypted ?? null}
      currentUserId={core.session?.user_id ?? null}
      scrollLocked={memberProfile.open || receiptsOpen}
      {typingUsers}
      footTrailingVisible={showReceiptFooter && timelineAtBottom && latestReadBy.length > 0}
      bind:nearLatest={timelineAtBottom}
      bind:followingLive={timelineFollowingLive}
      timelineStart={roomSession.predecessor ? predecessorNotice : undefined}
    >
      {#snippet footTrailing()}
        {#if showReceiptFooter}
          <RoomReadReceipts
            bind:open={receiptsOpen}
            readers={latestReadBy}
            timestamps={latestReceiptItem?.read_timestamps}
            members={receiptMembers}
            visible={timelineAtBottom}
            onMemberProfile={openProfile}
          />
        {/if}
      {/snippet}
    </TimelineList>
  {/key}
  <div
    class="composer-dock"
    onfocusin={(event) => timelineList?.composerFocused(event)}
    {@attach publishComposerClearance}
  >
    {#if isTombstoned}
      <RoomTombstoneBanner
        isSpace={resolvedRoom?.room_kind === 'space'}
        body={roomSession.tombstoneBody}
        resolved={roomSession.tombstoneChecked}
        successorId={roomSession.tombstoneReplacementId}
        joined={tombstoneJoin.successorJoined}
        joining={tombstoneJoin.joining}
        failed={tombstoneJoin.failed}
        onOpen={() => tombstoneJoin.open()}
        onJoin={() => void tombstoneJoin.join()}
      />
    {:else}
      {#if composerMounted}
        <ScheduledMessages
          roomId={resolvedRoomId}
          revision={conversation.scheduledRevision}
          editing={conversation.context?.kind === 'schedule' ? conversation.context.eventId : null}
          onEdit={conversation.editScheduled}
        />
        <ConversationComposer
          bind:this={composer}
          {conversation}
          roomId={resolvedRoomId}
          roomMembers={memberLoader.members}
          onSchedule={conversation.schedule}
          canReact={roomSession.permissions?.can_react ?? true}
          {roomName}
          readOnly={roomSession.permissions ? !roomSession.permissions.can_post : false}
          encrypted={resolvedRoom?.encrypted ?? null}
          onDeleteEdited={conversation.redact}
          onEditLast={conversation.editLast}
          onEditNext={conversation.editNext}
          onReplyStep={(direction) =>
            conversation.moveReply(timelineList?.stepReply(direction) ?? null)}
        />
      {/if}
    {/if}
  </div>
{/snippet}

<main
  class="room-view"
  aria-label={i18n.t('timeline.label')}
  data-inset-owner={voiceView ? 'top' : 'top bottom'}
>
  <div
    class={['timeline', { 'thread-covered': panels.threadRootId !== null && !threadInPanel }]}
    inert={panels.threadRootId !== null && !threadInPanel}
    bind:clientHeight={timelineHeight}
  >
    {#snippet headerActions()}
      <RoomHeaderActions
        {panels}
        {voiceView}
        {desktop}
        widgetCount={roomSession.widgets.length}
        {canManageWidgets}
      />
    {/snippet}
    <RoomHeader
      roomId={resolvedRoomId}
      {roomName}
      {roomAvatar}
      topic={roomTopic}
      isVoice={resolvedRoom?.room_kind === 'voice'}
      callParticipants={resolvedRoom?.call_participants ?? []}
      members={memberLoader.members}
      membersOpen={desktop ? panels.desktopMembersOpen : panels.membersOpen}
      searchOpen={panels.searchOpen}
      onCall={callOffered && !isVoiceRoom ? startCall : null}
      onToggleChat={isVoiceRoom ? () => (voiceChat.open = !voiceChat.open) : null}
      chatOpen={voiceChat.open}
      chatBeside={desktop}
      onBack={backToRoomList}
      onMembers={toggleMembers}
      onSearch={openSearch}
      onTopic={() => (topicOpen = true)}
      onAvatar={(source, name) => mediaViewer.openProfile(source, name)}
      {phone}
      actions={headerActions}
    >
      {#snippet pins()}
        <RoomPinMenu
          bind:open={pinsOpen}
          onUnread={(count) => (pinsUnread = count)}
          triggerHidden={phone}
          roomId={resolvedRoomId}
          revision={pinRevision}
          members={memberLoader.members}
          canPin={roomSession.permissions?.can_pin ?? false}
          onJump={jumpToEvent}
          onOpenMedia={openPanelMedia}
        />
      {/snippet}
      {#snippet menu()}
        <RoomHeaderMenu
          room={resolvedRoom ?? null}
          canInvite={roomSession.permissions?.can_invite ?? false}
          compact={!desktop}
          onMarkRead={markRoomRead}
          onMarkUnread={markRoomUnread}
          onInvite={() => (inviteOpen = true)}
          onMembers={toggleMembers}
          onSettings={() => (settingsOpen = true)}
          onJumpToTime={() => (jumpOpen = true)}
          onAttachments={voiceView ? undefined : toggleAttachments}
          onThreads={phone && !voiceView ? toggleThreads : undefined}
          onPins={phone ? () => (pinsOpen = true) : undefined}
          {pinsUnread}
          onWidgets={phone && (roomSession.widgets.length > 0 || canManageWidgets)
            ? toggleWidgets
            : undefined}
          onReport={() => (reportOpen = true)}
          onLeave={() => (leaveOpen = true)}
        />
      {/snippet}
    </RoomHeader>
    {#if callShown && (voiceView || !isVoiceRoom)}
      <RoomCallStage
        docked={!voiceView}
        ratio={callStageRatio}
        {timelineHeight}
        members={memberLoader.members}
        onInvite={roomSession.permissions?.can_invite ? () => (inviteOpen = true) : undefined}
      />
    {/if}
    {#if voiceView}
      {#if !callShown}
        <VoiceLobby
          participants={callParticipants}
          screenSharers={resolvedRoom?.screen_sharers ?? []}
          members={memberLoader.members}
          media={prescreenMedia}
          joining={call.lifecycle === 'joining'}
          canJoin={callable}
          hasPermission={callSupport.current?.can_join ?? false}
          hasFocus={callSupport.current?.has_focus ?? true}
          {roomName}
          selfId={core.session?.user_id ?? null}
          onChange={(media: CallMedia) => (prescreenMedia = media)}
          onJoin={joinCall}
          onOpenSettings={(event: MouseEvent) => openSettingsOver(event, 'calls')}
        />
      {/if}
    {:else}
      {@render chat()}
    {/if}
  </div>

  {#if panels.threadRootId !== null}
    {#key panels.threadRootId}
      <ThreadView
        roomId={resolvedRoomId}
        rootEventId={panels.threadRootId}
        focusEventId={threadEventId}
        sidePanel={threadInPanel}
        rootMessage={timeline.items.find((item) => item.event_id === panels.threadRootId)}
        {roomName}
        members={memberLoader.members}
        readOnly={roomSession.permissions ? !roomSession.permissions.can_post : false}
        canRedactOwn={roomSession.permissions?.can_redact_own ?? true}
        canRedactOthers={roomSession.permissions?.can_redact_others ?? false}
        canReact={roomSession.permissions?.can_react ?? true}
        canPin={roomSession.permissions?.can_pin ?? false}
        encrypted={resolvedRoom?.encrypted ?? null}
        onClose={closeThread}
        onSenderProfile={openProfile}
        onMatrixLink={handleMatrixLink}
        onCopyLink={copyEventLink}
      />
    {/key}
  {/if}

  {#if voiceChatBeside}
    <RoomVoiceChat covered={panels.threadRootId !== null && !threadInPanel} size={voiceChatWidth}>
      {@render chat()}
    </RoomVoiceChat>
  {/if}

  <RoomSidePanels
    {panels}
    room={resolvedRoom}
    roomId={resolvedRoomId}
    {desktop}
    {memberLoader}
    {roomSession}
    {canManageWidgets}
    onOpenThread={openThread}
    onJump={jumpToEvent}
    onOpenMedia={openPanelMedia}
    onMatrixLink={handleMatrixLink}
    onMemberProfile={openProfile}
  />

  <RoomDialogs
    room={resolvedRoom}
    roomId={resolvedRoomId}
    {roomName}
    topic={roomTopic}
    bind:topicOpen
    bind:inviteOpen
    bind:jumpOpen
    bind:reportOpen
    bind:leaveOpen
    bind:settingsOpen
    onJump={jumpToEvent}
    onMatrixLink={handleMatrixLink}
  />

  <MentionProfile
    open={memberProfile.open}
    onOpenChange={(open: boolean) => {
      if (open) memberProfile.open = true;
      else closeProfile();
    }}
    userId={memberProfile.userId}
    anchor={memberProfile.anchor}
    member={memberLoader.members.find((member) => member.user_id === memberProfile.userId) ?? null}
    roomId={resolvedRoomId}
    ownPowerLevel={memberLoader.members.find((member) => member.user_id === core.session?.user_id)
      ?.power_level ?? 0}
    permissions={roomSession.permissions}
    powerTags={roomSession.powerTags}
    profile={memberProfile.profile}
    pmp={memberProfile.pmp}
    failed={memberProfile.failed}
    onAvatarClick={openProfileAvatar}
    onMatrixLink={handleProfileLink}
    onPowerLevelChange={(target, userId, level) => {
      memberLoader.setPowerLevel(target, userId, level);
    }}
    onOpenMainAccount={() => {
      if (memberProfile.userId && memberProfile.anchor) {
        openProfile(memberProfile.userId, memberProfile.anchor);
      }
    }}
  />

  <RoomMediaViewerDialog
    viewer={mediaViewer}
    onJump={mediaViewer.panelItems ? jumpFromViewer : undefined}
  />
</main>

<style>
  :global(.widgets-button) {
    position: relative;
  }

  .room-view {
    --ghost-hover: var(--surface-container-hover);
    --ghost-active: var(--surface-container-active);

    background: var(--surface-container);
    color: var(--surface-on-container);
    display: flex;
    flex: 1;
    height: 100%;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .timeline {
    box-sizing: border-box;
    display: flex;
    flex: 1;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .timeline.thread-covered {
    inset: 0;
    pointer-events: none;
    position: absolute;
    visibility: hidden;
  }

  .composer-dock {
    flex: 0 0 auto;
    padding-bottom: max(var(--space-200), var(--edge-inset-bottom));
  }

  @media (--app-layout) {
    .room-view {
      overflow-x: clip;
    }

    .timeline {
      min-width: min(var(--room-column-min-width), 100% - var(--side-panel-min-width));
    }

    .room-view.room-view > :global(aside) {
      flex-shrink: 1;
      max-width: calc(100% - var(--room-column-min-width));
      min-width: var(--side-panel-min-width);
    }

    .composer-dock {
      --composer-band: calc(var(--sidebar-footer-height) - 2 * var(--space-300));

      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      margin-block-start: calc(-1 * var(--space-300));
      min-height: var(--sidebar-footer-height);
      padding-block: var(--space-300);
    }
  }
</style>
