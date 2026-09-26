<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import type {
    MemberView,
    MembershipView,
    PredecessorRoomView,
    ProfileView,
    RoomPowerLevelsView,
    RoomPermissionsView,
    RoomStateEventView,
    RoomSummary,
    CallSupportView,
  } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { ancestorSpaceIds } from './abbreviations';
  import {
    abbreviationChanges,
    provideRoomAbbreviations,
    RoomAbbreviations,
  } from './room-abbreviations.svelte.js';
  import { provideRoomMemberNames } from './room-member-names.js';
  import { notifiedRelation } from './notified-relation.js';
  import { PinnedEvents, providePinnedEvents } from './pinned-events.svelte.js';
  import { useBookmarks } from './bookmarks.svelte.js';
  import ConversationComposer from './ConversationComposer.svelte';
  import { Conversation } from './conversation.svelte.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { parseRoomWidget, type RoomWidget } from '#lib/features/widgets/widget-content.js';
  import WidgetsPanel from '#lib/features/widgets/WidgetsPanel.svelte';
  import { copyRoomLink, roomSectionPath } from '#lib/rooms/permalink.js';
  import {
    backToRoomList,
    leaveRoomView,
    scopedSearchQuery,
    searchInRoom,
    trackRoomEntry,
  } from './room-navigation.js';
  import {
    findRoomByPathId,
    roomLabel,
    roomPathParamFromId,
    useRoomList,
  } from '#lib/rooms/room-list.svelte.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
  import { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import { provideRoomCosmetics, RoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { activeRoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import ScheduledMessages from '#lib/features/composer/ScheduledMessages.svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { preferences, readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import VoiceLobby from '#lib/features/call/VoiceLobby.svelte';
  import { useCallSession, type CallMedia } from '#lib/features/call/call-session.svelte.js';
  import JumpToTimeDialog from './JumpToTimeDialog.svelte';
  import LeaveRoomDialog from './LeaveRoomDialog.svelte';
  import MembersDrawer from './MembersDrawer.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import ThreadList from './ThreadList.svelte';
  import RoomAttachments from './RoomAttachments.svelte';
  import RoomSearchPanel from './RoomSearchPanel.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import MentionProfile from './MentionProfile.svelte';
  import RoomHeader from './RoomHeader.svelte';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import RoomHeaderMenu from './RoomHeaderMenu.svelte';
  import RoomInviteDialog from './RoomInviteDialog.svelte';
  import { canSendState } from './settings/permission-groups';
  import RoomPinMenu from './RoomPinMenu.svelte';
  import RoomPredecessorNotice from './RoomPredecessorNotice.svelte';
  import RoomTombstoneBanner from './RoomTombstoneBanner.svelte';
  import RoomTopicViewer from './RoomTopicViewer.svelte';
  import RoomReadReceipts from './RoomReadReceipts.svelte';
  import RoomSettingsDialog from './RoomSettingsDialog.svelte';
  import TimelineList from './TimelineList.svelte';
  import MediaViewer, { type MediaItem } from './MediaViewer.svelte';
  import { galleryEventId, timelineMediaItems } from './media-items.js';
  import { parsePowerLevelTags, type PowerLevelTagMap } from './settings/power-level-tags.js';
  import { readTombstone } from './settings/room-upgrade.js';
  import { splitVia } from './join-address';
  import type { MatrixLink } from './matrix-link';
  import { eventBefore } from './timeline-format';

  interface Props {
    roomId: string;
    eventId?: string | null;
    notifiedEventId?: string | null;
    room?: RoomSummary;
  }

  let { roomId, eventId = null, notifiedEventId = null, room }: Props = $props();
  const core = useCoreClient();
  trackRoomEntry();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const timelineOwner = Symbol('room-view');
  const activeTimeline = activeRoomTimeline(core);
  const timeline = activeTimeline.timeline;
  const memberLoader = new RoomMemberLoader();
  const call = useCallSession();
  let prescreenMedia = $state<CallMedia>({ microphone: true, camera: false });
  let membersOpen = $state(false);
  let desktopMembersOpen = $state(true);
  let composer = $state<ConversationComposer>();
  let timelineList = $state<TimelineList>();
  let profileOpen = $state(false);
  let receiptsOpen = $state(false);
  let profileUserId = $state<string | null>(null);
  let profileAnchor = $state<HTMLElement | null>(null);
  let profile = $state<ProfileView | null>(null);
  let profileFailed = $state(false);
  const conversation = new Conversation({
    core,
    personas,
    timeline,
    roomId: () => resolvedRoomId,
    encrypted: () => resolvedRoom?.encrypted ?? null,
  });
  let profileRequestId = 0;
  let permissions = $state<RoomPermissionsView | null>(null);
  let powerLevels = $state<RoomPowerLevelsView | null>(null);
  let powerTags = $state.raw<PowerLevelTagMap | null>(null);
  let settingsOpen = $state(false);
  let topicOpen = $state(false);
  let inviteOpen = $state(false);
  let jumpOpen = $state(false);
  let leaveOpen = $state(false);
  let timelineAtBottom = $state(true);
  let timelineFollowingLive = $state<boolean>(false);
  let mediaEventId = $state<string | null>(null);
  let profileAvatarItem = $state<MediaItem | null>(null);
  let panelMediaItems = $state.raw<MediaItem[] | null>(null);
  let profileAvatarSequence = 0;
  let callSupport = $state<CallSupportView | null>(null);
  let callFallbackUrl = $state<string | null>(null);
  let widgetsOpen = $state(false);
  let widgets = $state.raw<RoomWidget[]>([]);
  let tombstoneReplacementId = $state<string | null>(null);
  let tombstoneBody = $state<string | null>(null);
  let tombstoneChecked = $state(false);
  let tombstoneJoining = $state(false);
  let tombstoneJoinFailed = $state(false);
  let predecessor = $state.raw<PredecessorRoomView | null>(null);

  let ownMember = $derived(
    memberLoader.members.find((member) => member.user_id === core.session?.user_id) ?? null
  );

  let mediaItems = $derived(
    profileAvatarItem
      ? [profileAvatarItem]
      : (panelMediaItems ?? timelineMediaItems(timeline.items))
  );

  $effect(() => {
    void runtimeConfig().then((config) => {
      callFallbackUrl = config.calls.livekitServiceUrl;
    });
  });

  $effect(() => {
    const target = resolvedRoomId;
    const fallback = callFallbackUrl;
    if (!target) return;

    let current = true;
    callSupport = null;
    if (typeof RTCPeerConnection === 'undefined') return;

    void core.commands
      .callSupport(target, fallback)
      .then((next) => {
        if (current) callSupport = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] call support unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  let pinRevision = $derived(
    timeline.items.reduce(
      (count, item) =>
        item.content.kind === 'state_event' && item.content.change?.kind === 'pinned_events'
          ? count + 1
          : count,
      0
    )
  );

  const pinnedEvents = new PinnedEvents(core.commands);
  providePinnedEvents(pinnedEvents);

  $effect(() => {
    if (pinRevision === 0) return;
    const target = resolvedRoomId;
    if (target) void pinnedEvents.load(target);
  });

  const bookmarks = useBookmarks();
  let threadRootId = $state<string | null>(null);
  let threadsOpen = $state(false);
  let attachmentsOpen = $state(false);
  let searchOpen = $state(false);

  function openThread(rootEventId: string): void {
    threadRootId = rootEventId;
    threadsOpen = false;
    attachmentsOpen = false;
    searchOpen = false;
    desktopMembersOpen = false;
  }

  function publishComposerClearance(node: HTMLElement): () => void {
    const root = document.documentElement;
    const update = (): void => {
      const clearance = Math.max(0, window.innerHeight - node.getBoundingClientRect().top);
      root.style.setProperty('--composer-clearance', `${String(clearance)}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const stopResize = on(window, 'resize', update);
    update();
    return () => {
      observer.disconnect();
      stopResize();
      root.style.removeProperty('--composer-clearance');
    };
  }

  function closeThread(): void {
    threadRootId = null;
  }

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
    core.commands
      .eventSource(target, eventId)
      .then((source) => {
        const relation = notifiedRelation(source);
        if (!active || relation === null) return;
        notifiedTarget = { eventId, target: relation.eventId };
        if (relation.thread) openThread(relation.eventId);
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
    const storedWidth = Number.parseInt(localStorage.getItem(VOICE_CHAT_WIDTH_KEY) ?? '', 10);
    if (Number.isFinite(storedWidth)) voiceChatWidth = clampVoiceChatWidth(storedWidth);
    const storedRatio = Number.parseFloat(localStorage.getItem(CALL_STAGE_RATIO_KEY) ?? '');
    callStageRatio = Number.isFinite(storedRatio)
      ? clampCallStageRatio(storedRatio)
      : sidePanels.matches
        ? CALL_STAGE_DEFAULT_RATIO
        : CALL_STAGE_MOBILE_RATIO;
  });
  let showReceiptFooter = $derived(
    !preferences.hideReadReceipts && preferences.readReceiptPlacement === 'room'
  );
  let latestReadBy = $derived.by(() => {
    if (!showReceiptFooter) return [];
    const userId = core.session?.user_id;
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if (!item.event_id) continue;
      return item.read_by.filter((readerId) => readerId !== userId);
    }
    return [];
  });
  let receiptMembers = $derived(
    memberLoader.members.filter((member) => latestReadBy.includes(member.user_id))
  );

  onDestroy(() => {
    void activeTimeline.stop(timelineOwner);
  });

  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId) ?? room);
  let callParticipants = $derived(resolvedRoom?.call_participants ?? []);
  let callable = $derived(
    !call.active &&
      callSupport !== null &&
      callSupport.can_join &&
      (callSupport.has_focus || callParticipants.length > 0)
  );
  let callOffered = $derived(
    callable &&
      ((resolvedRoom?.is_direct ?? false) ||
        callParticipants.length > 0 ||
        preferences.alwaysShowCallButton ||
        memberLoader.members.length <= 10)
  );

  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  const VOICE_CHAT_WIDTH_KEY = 'sable-voice-chat-width';
  const VOICE_CHAT_DEFAULT_WIDTH = 400;
  const VOICE_CHAT_MIN_WIDTH = 300;
  const VOICE_CHAT_MAX_WIDTH = 1000;

  function clampVoiceChatWidth(width: number): number {
    return Math.min(VOICE_CHAT_MAX_WIDTH, Math.max(VOICE_CHAT_MIN_WIDTH, width));
  }
  const CALL_STAGE_RATIO_KEY = 'sable-call-stage-ratio';
  const CALL_STAGE_DEFAULT_RATIO = 0.65;
  const CALL_STAGE_MOBILE_RATIO = 0.4;
  const CALL_STAGE_MIN_RATIO = 0.2;
  const CALL_STAGE_MAX_RATIO = 0.8;

  function clampCallStageRatio(ratio: number): number {
    return Math.min(CALL_STAGE_MAX_RATIO, Math.max(CALL_STAGE_MIN_RATIO, ratio));
  }
  let callStageRatio = $state(CALL_STAGE_DEFAULT_RATIO);
  let timelineHeight = $state(0);
  let isVoiceRoom = $derived(resolvedRoom?.is_voice ?? false);
  let voiceChatOpen = $state(false);
  let voiceChatWidth = $state(VOICE_CHAT_DEFAULT_WIDTH);
  let callShown = $derived(call.roomId === resolvedRoomId && (call.active || call.failure));
  let roomName = $derived(resolvedRoom ? roomLabel(resolvedRoom) : roomId);
  let roomAvatar = $derived(resolvedRoom?.avatar_url ?? null);
  let roomTopic = $derived(resolvedRoom?.topic ?? null);
  let isTombstoned = $derived(resolvedRoom?.is_tombstoned ?? false);
  let tombstoneSuccessor = $derived(
    tombstoneReplacementId ? findRoomByPathId(roomList.rooms, tombstoneReplacementId) : null
  );
  let tombstoneSuccessorJoined = $derived(tombstoneSuccessor?.state === 'joined');

  const abbreviations = new RoomAbbreviations(core.commands);
  provideRoomAbbreviations(abbreviations);
  provideRoomMemberNames({ displayName: memberDisplayName });

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
      .filter((room) => room.state === 'joined' && !room.is_space)
      .reduce((total, room) => total + roomList.notificationsFor(room).highlight, 0)
  );
  let pageTitle = $derived(
    mentionCount > 0 ? `(${mentionCount}) ${roomName} - Sable` : `${roomName} - Sable`
  );
  const sidePanels = createMediaQuery(BREAKPOINTS.sidePanels);
  let desktop = $derived(sidePanels.matches);
  let voiceView = $derived(isVoiceRoom && (!voiceChatOpen || desktop));
  let voiceChatBeside = $derived(isVoiceRoom && voiceChatOpen && desktop);
  let typingUserIds = $derived(roomList.typingUserIds(resolvedRoomId));
  let typingLabel = $derived.by(() => {
    if (preferences.hideTypingIndicators || typingUserIds.length === 0) return null;
    const names = typingUserIds.slice(0, 3).map(memberDisplayName);
    if (names.some((name) => name === null)) return $i18n.t('timeline.unknownTyping');
    if (names.length === 1) return $i18n.t('timeline.oneTyping', { name: names[0] });
    if (names.length === 2)
      return $i18n.t('timeline.twoTyping', { name1: names[0], name2: names[1] });
    if (names.length === 3 && typingUserIds.length === 3) {
      return $i18n.t('timeline.threeTyping', { name1: names[0], name2: names[1], name3: names[2] });
    }
    return $i18n.t('timeline.manyTyping', {
      name1: names[0],
      name2: names[1],
      count: typingUserIds.length - 2,
    });
  });

  $effect(() => {
    void resolvedRoomId;
    memberLoader.reset();
    conversation.forgetRequestedDetails();
    receiptsOpen = false;
    threadRootId = null;
    threadsOpen = false;
    attachmentsOpen = false;
    searchOpen = false;
    closeProfile();
  });

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    permissions = null;
    powerLevels = null;
    powerTags = null;
    widgets = [];
    predecessor = null;
    let current = true;
    void core.commands
      .roomOpen(activeRoomId)
      .then((opened) => {
        if (!current) return;
        permissions = opened.permissions;
        predecessor = opened.predecessor;
        powerTags = parsePowerLevelTags(opened.power_level_tags);
        widgets = parseRoomWidgets(opened.widgets);
        pinnedEvents.set(activeRoomId, opened.pinned_event_ids);
      })
      .catch((error: unknown) => {
        console.debug('[sable room] room details unavailable', error);
        if (current) powerTags = {};
      });
    void core.commands
      .roomPowerLevels(activeRoomId)
      .then((next) => {
        if (current) powerLevels = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] power levels unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  let canManageWidgets = $derived(
    canSendState(powerLevels, permissions?.own_power_level ?? 0, 'im.vector.modular.widgets')
  );

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    const tombstoned = isTombstoned;
    tombstoneReplacementId = null;
    tombstoneBody = null;
    tombstoneChecked = false;
    tombstoneJoinFailed = false;
    if (!tombstoned) return;

    let current = true;
    void core.commands
      .roomStateEvent(activeRoomId, 'm.room.tombstone')
      .then((content) => {
        if (!current) return;
        const grave = readTombstone(content);
        tombstoneReplacementId = grave.replacement;
        tombstoneBody = grave.body;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] tombstone unavailable', error);
      })
      .finally(() => {
        if (current) tombstoneChecked = true;
      });
    return () => {
      current = false;
    };
  });

  $effect(() => {
    if (desktop && desktopMembersOpen) void loadMembers();
  });

  // The SDK loads a replied-to event lazily, so a reply preview stays blank
  // until it is asked for.
  $effect(() => {
    conversation.fetchMissingReplyDetails();
  });

  $effect(() => {
    void roomId;
    timelineAtBottom = eventId === null;
  });

  // The URL describes what is on screen, so returning to live drops the anchor.
  // Waiting for live mode matters: in permalink mode following the end only
  // means the bottom of the loaded context, and dropping the anchor there
  // restarts at the present.
  /** The `?event=` the effect below has handed to the timeline. */
  let appliedEventId: string | null = null;

  $effect(() => {
    // Waiting for the target to have been applied matters as much as waiting
    // for live mode. Restarting the timeline is async, so at the moment of a
    // jump the mode is still `live` and this would strip the anchor straight
    // back off the URL, undoing the navigation before it takes effect.
    if (eventId === null || eventId !== appliedEventId) return;
    if (!timelineFollowingLive || timeline.mode.kind !== 'live') return;
    void goto(roomUrl(null), { replace: true, reset: false });
  });

  $effect(() => {
    const activeRoomId = resolvedRoom?.room_id;
    if (!activeRoomId) return;
    const anchor = untrack(() => {
      // An event already in the loaded range is reached by scrolling, so only a
      // target we do not hold restarts the timeline in permalink mode. That
      // only holds while live: dropping the anchor from a focused timeline
      // restarts it at the present instead of moving within the loaded window.
      const loaded = timeline.items.some((item) => item.event_id === eventId);
      return loaded && timeline.mode.kind === 'live' ? null : eventId;
    });
    appliedEventId = eventId;
    // Read outside `untrack`: the toggle only takes effect by re-subscribing.
    const hiddenEvents = preferences.showHiddenEvents;
    void untrack(() => activeTimeline.start(timelineOwner, activeRoomId, anchor, hiddenEvents));
    void untrack(() => loadMembers());
  });

  async function loadMembers(): Promise<void> {
    const activeRoomId = resolvedRoomId;
    await memberLoader.load(activeRoomId, (roomId) => core.commands.roomMembers(roomId));
  }

  function loadMembership(membership: MembershipView): Promise<MemberView[]> {
    return core.commands.roomMembers(resolvedRoomId, [membership]);
  }

  function toggleMembers(): void {
    const opening = desktop ? !desktopMembersOpen : !membersOpen;
    if (desktop) desktopMembersOpen = opening;
    else membersOpen = opening;
    if (opening) void loadMembers();
  }

  function closeMembers(): void {
    if (desktop) desktopMembersOpen = false;
    else membersOpen = false;
  }

  function parseRoomWidgets(events: readonly RoomStateEventView[]): RoomWidget[] {
    return events.flatMap((event) => {
      const widget = parseRoomWidget(event.state_key, event.content);
      return widget ? [widget] : [];
    });
  }

  async function loadWidgets(activeRoomId: string): Promise<RoomWidget[]> {
    return parseRoomWidgets(
      await core.commands.roomStateEvents(activeRoomId, 'im.vector.modular.widgets')
    );
  }

  function toggleWidgets(): void {
    widgetsOpen = !widgetsOpen;
  }

  function closeWidgets(): void {
    widgetsOpen = false;
  }

  async function removeWidget(widgetId: string): Promise<void> {
    const activeRoomId = resolvedRoomId;
    try {
      await core.commands.sendStateEvent(activeRoomId, 'im.vector.modular.widgets', widgetId, {});
      widgets = await loadWidgets(activeRoomId);
    } catch (error) {
      console.warn('[sable room] remove widget failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  function closeProfile(): void {
    profileRequestId += 1;
    profileOpen = false;
    profileUserId = null;
    profileAnchor = null;
    profile = null;
    profileFailed = false;
  }

  function mentionUser(userId: string, name: string): void {
    composer?.insertMention(userId, name);
  }

  function openProfile(userId: string, anchor: HTMLElement): void {
    const requestId = ++profileRequestId;
    profileUserId = userId;
    profileAnchor = anchor;
    profileOpen = true;
    profile = null;
    profileFailed = false;
    void loadMembers();
    void core
      .userProfile(userId)
      .then((nextProfile) => {
        if (profileRequestId === requestId) profile = nextProfile;
      })
      .catch(() => {
        if (profileRequestId === requestId) profileFailed = true;
      });
  }

  function handleMatrixLink(link: MatrixLink, anchor: HTMLAnchorElement): void {
    if (link.kind === 'user') {
      openProfile(link.userId, anchor);
      return;
    }

    // The href carries `?via=` inside the fragment, which the parsed link drops.
    const { via } = splitVia(anchor.href);
    const target = roomSectionPath(
      roomList.rooms,
      link.roomId,
      link.kind === 'event' ? link.eventId : null,
      via
    );
    void goto(target);
  }

  function copyEventLink(eventId: string): void {
    void writeEventLink(eventId);
  }

  async function writeEventLink(eventId: string): Promise<void> {
    const room = {
      room_id: resolvedRoomId,
      canonical_alias: resolvedRoom?.canonical_alias ?? null,
    };
    if (!(await copyRoomLink(core, room, eventId))) toasts.error($i18n.t('errors.copyFailed'));
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
    void goto('', { shallow: true, replace: true, state: { ...page.state, notified: undefined } });
  }

  function jumpToLive(): void {
    void goto(roomUrl(null), { replace: true });
  }

  // A history entry, so back is a way out of the anchor.
  function jumpToEvent(eventId: string): void {
    void goto(roomUrl(eventId), { reset: false });
  }

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  async function markRead(eventId: string): Promise<void> {
    await core.commands.markRead(
      resolvedRoomId,
      eventId,
      readReceiptIsPrivate(),
      null,
      timeline.subscriptionId
    );
  }

  function markUnreadFrom(eventId: string): void {
    void core.commands
      .markUnread(resolvedRoomId, eventBefore(timeline.items, eventId))
      .catch((error: unknown) => {
        console.warn('[sable room] mark as unread failed', error);
      });
  }

  function markRoomRead(): void {
    void core.commands
      .markRead(resolvedRoomId, null, readReceiptIsPrivate())
      .catch((error: unknown) => {
        console.warn('[sable room] mark as read failed', error);
      });
  }

  function markRoomUnread(): void {
    void core.commands.markUnread(resolvedRoomId).catch((error: unknown) => {
      console.warn('[sable room] mark as unread failed', error);
    });
  }

  function openMedia(eventId: string): void {
    profileAvatarItem = null;
    panelMediaItems = null;
    mediaEventId = eventId;
  }

  function openPanelMedia(items: MediaItem[], eventId: string): void {
    profileAvatarItem = null;
    panelMediaItems = items;
    mediaEventId = eventId;
  }

  function jumpFromViewer(eventId: string): void {
    closeMedia();
    if (!desktop) attachmentsOpen = false;
    void afterOverlayPops().then(() => {
      jumpToEvent(galleryEventId(eventId));
    });
  }

  function toggleAttachments(): void {
    attachmentsOpen = !attachmentsOpen;
    threadsOpen = false;
    searchOpen = false;
  }

  function openSearch(): void {
    if (!desktop) {
      searchInRoom(resolvedRoom, resolvedRoomId);
      return;
    }
    searchOpen = !searchOpen;
    threadsOpen = false;
    attachmentsOpen = false;
    if (searchOpen) desktopMembersOpen = false;
  }

  function openProfileAvatar(source: string, displayName: string): void {
    closeProfile();
    const eventId = `profile-avatar-${String(++profileAvatarSequence)}`;
    profileAvatarItem = {
      kind: 'image',
      filename: displayName,
      caption: null,
      html: null,
      source,
      mime: null,
      width: null,
      height: null,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      eventId,
      sender: displayName,
    };
    mediaEventId = eventId;
  }

  function closeMedia(): void {
    mediaEventId = null;
    profileAvatarItem = null;
    panelMediaItems = null;
  }

  function tombstoneSuccessorPath(id: string, isSpace: boolean): string {
    const param = roomPathParamFromId(id);
    return isSpace
      ? resolve('/(app)/space/[spaceId]', { spaceId: param })
      : resolve('/(app)/rooms/[roomId]', { roomId: param });
  }

  function openTombstoneSuccessor(): void {
    if (!tombstoneReplacementId) return;
    const isSpace = tombstoneSuccessor?.is_space ?? resolvedRoom?.is_space ?? false;
    void goto(tombstoneSuccessorPath(tombstoneReplacementId, isSpace));
  }

  async function joinTombstoneSuccessor(): Promise<void> {
    const target = tombstoneReplacementId;
    if (!target || tombstoneJoining) return;

    tombstoneJoining = true;
    tombstoneJoinFailed = false;
    try {
      const via = await core.commands.roomViaServers(resolvedRoomId);
      const joinedId = await core.commands.joinRoom(target, via);
      const isSpace = resolvedRoom?.is_space ?? false;
      void goto(tombstoneSuccessorPath(joinedId, isSpace));
    } catch (error) {
      console.warn('[sable room] joining the replacement room failed', error);
      tombstoneJoinFailed = true;
    } finally {
      tombstoneJoining = false;
    }
  }

  function openPredecessor(): void {
    if (!predecessor) return;
    void goto(roomSectionPath(roomList.rooms, predecessor.room_id, null, predecessor.via));
  }

  function startCall(): void {
    call.clearFailure();
    void call.join(resolvedRoomId, { microphone: true, camera: false }, callFallbackUrl);
  }

  function joinCall(): void {
    void call.join(resolvedRoomId, prescreenMedia, callFallbackUrl);
  }
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

{#snippet predecessorNotice()}
  <RoomPredecessorNotice onOpen={openPredecessor} />
{/snippet}

{#snippet chat()}
  {#key resolvedRoomId}
    <TimelineList
      bind:this={timelineList}
      replyEventId={conversation.context?.kind === 'reply' ? conversation.context.eventId : null}
      {timeline}
      focusEventId={eventId}
      {landingEventId}
      onLanded={landed}
      onRequestHistory={requestHistory}
      onRequestFuture={requestFuture}
      onRead={markRead}
      onMarkUnread={markUnreadFrom}
      onMatrixLink={handleMatrixLink}
      onCopyLink={copyEventLink}
      onSenderProfile={openProfile}
      onMentionUser={mentionUser}
      onRetrySend={conversation.retrySend}
      onCancelSend={conversation.cancelSend}
      onToggleReaction={permissions?.can_react === false ? undefined : conversation.toggleReaction}
      onDelete={conversation.redact}
      onReply={permissions?.can_post === false ? undefined : conversation.reply}
      onOpenThread={openThread}
      onEdit={permissions?.can_post === false ? undefined : conversation.edit}
      roomId={resolvedRoomId}
      members={memberLoader.members}
      onJumpToEvent={jumpToEvent}
      onJumpToLive={jumpToLive}
      onOpenMedia={openMedia}
      onPersonaAvatarClick={openProfileAvatar}
      onVotePoll={conversation.votePoll}
      onEndPoll={conversation.endPoll}
      readOnly={permissions ? !permissions.can_post : false}
      canRedactOwn={permissions?.can_redact_own ?? true}
      canRedactOthers={permissions?.can_redact_others ?? false}
      canPin={permissions?.can_pin ?? false}
      encrypted={resolvedRoom?.encrypted ?? null}
      currentUserId={core.session?.user_id ?? null}
      scrollLocked={profileOpen || receiptsOpen}
      {typingLabel}
      footTrailingVisible={showReceiptFooter && timelineAtBottom && latestReadBy.length > 0}
      bind:nearLatest={timelineAtBottom}
      bind:followingLive={timelineFollowingLive}
      timelineStart={predecessor ? predecessorNotice : undefined}
    >
      {#snippet footTrailing()}
        {#if showReceiptFooter}
          <RoomReadReceipts
            bind:open={receiptsOpen}
            readers={latestReadBy}
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
        isSpace={resolvedRoom?.is_space ?? false}
        body={tombstoneBody}
        resolved={tombstoneChecked}
        successorId={tombstoneReplacementId}
        joined={tombstoneSuccessorJoined}
        joining={tombstoneJoining}
        failed={tombstoneJoinFailed}
        onOpen={openTombstoneSuccessor}
        onJoin={() => void joinTombstoneSuccessor()}
      />
    {:else}
      {#key resolvedRoomId}
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
          onSchedule={conversation.schedule}
          {roomName}
          readOnly={permissions ? !permissions.can_post : false}
          encrypted={resolvedRoom?.encrypted ?? null}
          onDeleteEdited={conversation.redact}
          onEditLast={conversation.editLast}
          onReplyStep={(direction) =>
            conversation.moveReply(timelineList?.stepReply(direction) ?? null)}
        />
      {/key}
    {/if}
  </div>
{/snippet}

<main
  class="room-view"
  aria-label={$i18n.t('timeline.label')}
  data-inset-owner={voiceView ? 'top' : 'top bottom'}
>
  <div class="timeline" bind:clientHeight={timelineHeight}>
    {#snippet headerActions()}
      {#if !voiceView}
        <PanelHeaderButton
          label={$i18n.t('timeline.threadsOpen')}
          aria-pressed={threadsOpen}
          onclick={() => {
            threadsOpen = !threadsOpen;
            attachmentsOpen = false;
            searchOpen = false;
          }}
        >
          <ChatsIcon weight={threadsOpen ? 'fill' : 'regular'} />
        </PanelHeaderButton>
        {#if desktop}
          <PanelHeaderButton
            label={$i18n.t('timeline.attachmentsOpen')}
            aria-pressed={attachmentsOpen}
            onclick={toggleAttachments}
          >
            <ImagesIcon weight={attachmentsOpen ? 'fill' : 'regular'} />
          </PanelHeaderButton>
        {/if}
      {/if}
      {#if widgets.length > 0}
        <PanelHeaderButton label={$i18n.t('widgets.label')} onclick={toggleWidgets}>
          <GridFourIcon />
        </PanelHeaderButton>
      {/if}
    {/snippet}
    <RoomHeader
      roomId={resolvedRoomId}
      {roomName}
      {roomAvatar}
      topic={roomTopic}
      isVoice={resolvedRoom?.is_voice ?? false}
      callParticipants={resolvedRoom?.call_participants ?? []}
      members={memberLoader.members}
      membersOpen={desktop ? desktopMembersOpen : membersOpen}
      onCall={callOffered && !isVoiceRoom ? startCall : null}
      onToggleChat={isVoiceRoom ? () => (voiceChatOpen = !voiceChatOpen) : null}
      chatOpen={voiceChatOpen}
      chatBeside={desktop}
      onBack={backToRoomList}
      onMembers={toggleMembers}
      onSearch={openSearch}
      onTopic={() => (topicOpen = true)}
      actions={headerActions}
    >
      {#snippet pins()}
        <RoomPinMenu
          roomId={resolvedRoomId}
          revision={pinRevision}
          members={memberLoader.members}
          canPin={permissions?.can_pin ?? false}
          onJump={jumpToEvent}
        />
      {/snippet}
      {#snippet menu()}
        <RoomHeaderMenu
          room={resolvedRoom ?? null}
          canInvite={permissions?.can_invite ?? false}
          compact={!desktop}
          onMarkRead={markRoomRead}
          onMarkUnread={markRoomUnread}
          onInvite={() => (inviteOpen = true)}
          onMembers={toggleMembers}
          onSettings={() => (settingsOpen = true)}
          onJumpToTime={() => (jumpOpen = true)}
          onAttachments={voiceView ? undefined : toggleAttachments}
          onLeave={() => (leaveOpen = true)}
        />
      {/snippet}
    </RoomHeader>
    {#if callShown && (voiceView || !isVoiceRoom)}
      <div
        class="call-stage"
        class:docked={!voiceView}
        style:flex-basis={voiceView ? undefined : `${callStageRatio * 100}%`}
      >
        {#await import('#lib/features/call/CallView.svelte') then { default: CallView }}
          <CallView
            session={call}
            members={memberLoader.members}
            onInvite={permissions?.can_invite ? () => (inviteOpen = true) : undefined}
            onOpenSettings={(event: MouseEvent) => openSettingsOver(event, 'calls')}
          />
        {/await}
        {#if !voiceView}
          <ResizeHandle
            value={callStageRatio}
            min={CALL_STAGE_MIN_RATIO}
            max={CALL_STAGE_MAX_RATIO}
            label={$i18n.t('call.resizeStage')}
            valueText={$i18n.t('call.stageShare', { percent: Math.round(callStageRatio * 100) })}
            grow="down"
            step={0.05}
            shiftStep={0.15}
            fromPixels={(pixels) => (timelineHeight > 0 ? pixels / timelineHeight : 0)}
            onResize={(next) => (callStageRatio = clampCallStageRatio(next))}
            onCommit={() => localStorage.setItem(CALL_STAGE_RATIO_KEY, String(callStageRatio))}
          />
        {/if}
      </div>
    {/if}
    {#if voiceView}
      {#if !callShown}
        <VoiceLobby
          participants={callParticipants}
          members={memberLoader.members}
          media={prescreenMedia}
          joining={call.lifecycle === 'joining'}
          canJoin={callable}
          hasPermission={callSupport?.can_join ?? false}
          hasFocus={callSupport?.has_focus ?? true}
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

  {#if voiceChatBeside}
    <aside class="voice-chat" style:width="{voiceChatWidth}px" aria-label={$i18n.t('call.chat')}>
      <ResizeHandle
        value={voiceChatWidth}
        min={VOICE_CHAT_MIN_WIDTH}
        max={VOICE_CHAT_MAX_WIDTH}
        label={$i18n.t('call.chat')}
        grow="left"
        step={16}
        shiftStep={64}
        onResize={(next) => (voiceChatWidth = clampVoiceChatWidth(next))}
        onCommit={() => localStorage.setItem(VOICE_CHAT_WIDTH_KEY, String(voiceChatWidth))}
      />
      <PanelHeader class="voice-chat-header" title={$i18n.t('call.chat')}>
        {#snippet suffix()}
          <PanelHeaderButton
            label={$i18n.t('call.closeChat')}
            onclick={() => (voiceChatOpen = false)}
          >
            <XIcon />
          </PanelHeaderButton>
        {/snippet}
      </PanelHeader>
      {@render chat()}
    </aside>
  {/if}

  {#if threadsOpen}
    <ThreadList
      roomId={resolvedRoomId}
      members={memberLoader.members}
      modal={!desktop}
      onOpenThread={openThread}
      onClose={() => (threadsOpen = false)}
    />
  {/if}

  {#if searchOpen}
    {#key resolvedRoomId}
      <RoomSearchPanel
        query={scopedSearchQuery('in', resolvedRoom, resolvedRoomId)}
        onClose={() => (searchOpen = false)}
      />
    {/key}
  {/if}

  {#if attachmentsOpen}
    <RoomAttachments
      roomId={resolvedRoomId}
      members={memberLoader.members}
      modal={!desktop}
      onJump={jumpToEvent}
      onOpenMedia={openPanelMedia}
      onMatrixLink={handleMatrixLink}
      onClose={() => (attachmentsOpen = false)}
    />
  {/if}

  {#if desktop}
    {#if threadRootId !== null}
      {#key threadRootId}
        <ThreadPanel
          roomId={resolvedRoomId}
          rootEventId={threadRootId}
          {roomName}
          members={memberLoader.members}
          readOnly={permissions ? !permissions.can_post : false}
          canRedactOwn={permissions?.can_redact_own ?? true}
          canRedactOthers={permissions?.can_redact_others ?? false}
          canReact={permissions?.can_react ?? true}
          canPin={permissions?.can_pin ?? false}
          encrypted={resolvedRoom?.encrypted ?? null}
          onClose={closeThread}
          onSenderProfile={openProfile}
          onCopyLink={copyEventLink}
          onPersonaAvatarClick={openProfileAvatar}
        />
      {/key}
    {/if}
    {#if desktopMembersOpen}
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        {powerTags}
        {loadMembership}
        onClose={closeMembers}
        onMemberProfile={openProfile}
      />
    {/if}
    {#if widgetsOpen}
      <WidgetsPanel
        roomId={resolvedRoomId}
        {widgets}
        userId={core.session?.user_id ?? ''}
        displayName={ownMember?.display_name ?? core.session?.user_id ?? ''}
        avatarUrl={ownMember?.avatar_url ?? ''}
        canManage={canManageWidgets}
        onClose={closeWidgets}
        onRemove={removeWidget}
      />
    {/if}
  {:else}
    <DialogFrame bind:open={membersOpen} variant="drawer">
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        modal
        {powerTags}
        {loadMembership}
        onClose={closeMembers}
        onMemberProfile={openProfile}
      />
    </DialogFrame>
  {/if}

  {#if !desktop}
    {#if threadRootId !== null}
      {#key threadRootId}
        <ThreadPanel
          roomId={resolvedRoomId}
          rootEventId={threadRootId}
          {roomName}
          members={memberLoader.members}
          readOnly={permissions ? !permissions.can_post : false}
          canRedactOwn={permissions?.can_redact_own ?? true}
          canRedactOthers={permissions?.can_redact_others ?? false}
          canReact={permissions?.can_react ?? true}
          canPin={permissions?.can_pin ?? false}
          encrypted={resolvedRoom?.encrypted ?? null}
          modal
          onClose={closeThread}
          onSenderProfile={openProfile}
          onCopyLink={copyEventLink}
          onPersonaAvatarClick={openProfileAvatar}
        />
      {/key}
    {/if}
  {/if}

  {#if !desktop}
    <DialogFrame
      open={widgetsOpen}
      onOpenChange={(open: boolean) => {
        if (!open) closeWidgets();
      }}
      variant="drawer"
    >
      <WidgetsPanel
        roomId={resolvedRoomId}
        {widgets}
        userId={core.session?.user_id ?? ''}
        displayName={ownMember?.display_name ?? core.session?.user_id ?? ''}
        avatarUrl={ownMember?.avatar_url ?? ''}
        canManage={canManageWidgets}
        modal
        onClose={closeWidgets}
        onRemove={removeWidget}
      />
    </DialogFrame>
  {/if}

  <RoomTopicViewer
    open={topicOpen}
    {roomName}
    topic={roomTopic ?? ''}
    onOpenChange={(open: boolean) => {
      topicOpen = open;
    }}
    onMatrixLink={(link, anchor) => {
      topicOpen = false;
      handleMatrixLink(link, anchor);
    }}
  />

  <RoomInviteDialog
    open={inviteOpen}
    room={resolvedRoom ?? null}
    onOpenChange={(open: boolean) => {
      inviteOpen = open;
    }}
  />

  <JumpToTimeDialog
    open={jumpOpen}
    roomId={resolvedRoomId}
    onOpenChange={(open: boolean) => {
      jumpOpen = open;
    }}
    onJump={jumpToEvent}
  />

  <LeaveRoomDialog
    open={leaveOpen}
    room={resolvedRoom ?? null}
    onOpenChange={(open: boolean) => {
      leaveOpen = open;
    }}
    onLeft={leaveRoomView}
  />

  <RoomSettingsDialog
    open={settingsOpen}
    room={resolvedRoom ?? null}
    onOpenChange={(open: boolean) => {
      settingsOpen = open;
    }}
  />

  <MentionProfile
    open={profileOpen}
    onOpenChange={(open: boolean) => {
      if (open) profileOpen = true;
      else closeProfile();
    }}
    userId={profileUserId}
    anchor={profileAnchor}
    member={memberLoader.members.find((member) => member.user_id === profileUserId) ?? null}
    {roomId}
    ownPowerLevel={memberLoader.members.find((member) => member.user_id === core.session?.user_id)
      ?.power_level ?? 0}
    {permissions}
    {powerTags}
    {profile}
    failed={profileFailed}
    onAvatarClick={openProfileAvatar}
    onMatrixLink={handleMatrixLink}
    onPowerLevelChange={(target, userId, level) => {
      memberLoader.setPowerLevel(target, userId, level);
    }}
  />

  {#if mediaEventId}
    <MediaViewer
      items={mediaItems}
      selectedEventId={mediaEventId}
      onClose={closeMedia}
      onJump={panelMediaItems ? jumpFromViewer : undefined}
    />
  {/if}
</main>

<style>
  .room-view {
    --ghost-hover: var(--surface-container-hover);
    --ghost-active: var(--surface-container-active);

    background: var(--surface-container);
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

  .call-stage {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .call-stage.docked {
    flex-grow: 0;
    flex-shrink: 0;
    min-height: 10rem;
  }

  .call-stage :global(.resize-handle) {
    bottom: -0.25rem;
    z-index: 3;
  }

  .call-stage :global(.resize-handle)::after {
    background: var(--surface-container-line);
    border-radius: var(--radii-pill);
    content: '';
    height: 0.25rem;
    left: 50%;
    position: absolute;
    top: 50%;
    translate: -50% -50%;
    width: 2.5rem;
  }

  .voice-chat {
    background: var(--surface-container);
    border-left: var(--border-width) solid var(--surface-container-line);
    box-sizing: border-box;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    max-width: 60%;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .voice-chat :global(.resize-handle) {
    left: -0.25rem;
    z-index: 1;
  }

  .composer-dock {
    flex: 0 0 auto;
    padding-bottom: max(var(--space-200), var(--edge-inset-bottom));
  }

  @media (width >= 48rem) {
    .composer-dock {
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: center;
      margin-block-start: calc(-1 * var(--space-300));
      min-height: var(--sidebar-footer-height);
      padding-block: var(--space-300);
    }
  }
</style>
