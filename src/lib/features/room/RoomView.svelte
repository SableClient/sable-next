<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import type {
    MemberView,
    MembershipView,
    RoomSummary,
    CallSupportView,
    PerMessageProfileView,
  } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { voiceChat } from '#lib/features/room/voice-chat.svelte.js';
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
  import { provideRoomMemberNames } from './members/room-member-names.js';
  import { notifiedRelation } from './messages/notified-relation.js';
  import { PinnedEvents, providePinnedEvents } from './timeline/pinned-events.svelte.js';
  import { useBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import ConversationComposer from './conversation/ConversationComposer.svelte';
  import { Conversation } from './conversation/conversation.svelte.js';
  import { personaSpaces } from '#lib/features/composer/persona-spaces.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops, holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
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
  import { activeRoomTimeline, type ResumeAnchor } from '#lib/rooms/timeline.svelte.js';
  import ScheduledMessages from '#lib/features/composer/ScheduledMessages.svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { composerClearance } from '#lib/ui/composer-clearance.svelte.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { preferences, readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import VoiceLobby from '#lib/features/call/VoiceLobby.svelte';
  import { useCallSession, type CallMedia } from '#lib/features/call/call-session.svelte.js';
  import JumpToTimeDialog from './timeline/JumpToTimeDialog.svelte';
  import LeaveRoomDialog from './LeaveRoomDialog.svelte';
  import MessageReportDialog from './messages/MessageReportDialog.svelte';
  import { sendReport } from './messages/report';
  import {
    provideRoomMediaPreviews,
    RoomMediaPreviews,
  } from './media/room-media-previews.svelte.js';
  import MembersDrawer from './members/MembersDrawer.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import ThreadList from './conversation/ThreadList.svelte';
  import RoomAttachments from './media/RoomAttachments.svelte';
  import RoomSearchPanel from './RoomSearchPanel.svelte';
  import ThreadView from './conversation/ThreadView.svelte';
  import MentionProfile from './members/MentionProfile.svelte';
  import RoomHeader from './RoomHeader.svelte';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import RoomHeaderMenu from './RoomHeaderMenu.svelte';
  import RoomInviteDialog from './RoomInviteDialog.svelte';
  import { canSendState } from './settings/permission-groups';
  import RoomPinMenu from './RoomPinMenu.svelte';
  import RoomPredecessorNotice from './RoomPredecessorNotice.svelte';
  import RoomTombstoneBanner from './RoomTombstoneBanner.svelte';
  import RoomTopicViewer from './RoomTopicViewer.svelte';
  import RoomReadReceipts from './timeline/RoomReadReceipts.svelte';
  import RoomSettingsDialog from './settings/RoomSettingsDialog.svelte';
  import TimelineList from './timeline/TimelineList.svelte';
  import MediaViewer, { type MediaItem } from './media/MediaViewer.svelte';
  import { galleryEventId, timelineMediaItems } from './media/media-items.js';
  import {
    provideMediaViewerOpener,
    type StandaloneMedia,
  } from './media/media-viewer-opener.svelte.js';
  import { tagForLevel } from './settings/power-level-tags.js';
  import { memberListChanges } from './settings/member-list.svelte.js';
  import { provideSenderRoles, type SenderRole } from './members/sender-roles.js';
  import { powerTag } from './members/power-tags';
  import { splitVia } from '#lib/rooms/join-address.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { eventBefore } from './timeline/timeline-format';
  import { RoomSession } from './room-session.svelte.js';
  import { MemberProfile } from './members/member-profile.svelte.js';
  import { RoomPanels } from './room-panels.svelte.js';

  interface Props {
    roomId: string;
    eventId?: string | null;
    notifiedEventId?: string | null;
    room?: RoomSummary;
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
  const activeTimeline = activeRoomTimeline(core);
  const timeline = activeTimeline.timeline;
  const memberLoader = new RoomMemberLoader();
  const call = useCallSession();
  let prescreenMedia = $state<CallMedia>({ microphone: true, camera: false });
  let composer = $state<ConversationComposer>();
  let timelineList = $state<TimelineList>();
  let receiptsOpen = $state(false);
  const conversation = new Conversation({
    core,
    personas,
    timeline,
    roomId: () => resolvedRoomId,
    spaceIds: (id) => personaSpaces(roomList.rooms, id, page.params.spaceId).order,
    encrypted: () => resolvedRoom?.encrypted ?? null,
    beforeSend: () => timelineList?.resumeLive(false) ?? resumeLive(),
  });
  let settingsOpen = $state(false);
  let topicOpen = $state(false);
  let inviteOpen = $state(false);
  let jumpOpen = $state(false);
  let leaveOpen = $state(false);
  let reportOpen = $state(false);
  let timelineAtBottom = $state(true);
  let timelineFollowingLive = $state<boolean>(false);
  let mediaEventId = $state<string | null>(null);
  let standaloneMediaItem = $state<MediaItem | null>(null);
  let panelMediaItems = $state.raw<MediaItem[] | null>(null);
  let standaloneSequence = 0;
  let callSupport = $state<CallSupportView | null>(null);
  let callFallbackUrl = $state<string | null>(null);
  let tombstoneJoining = $state(false);
  let tombstoneJoinFailed = $state(false);

  let ownMember = $derived(
    memberLoader.members.find((member) => member.user_id === core.session?.user_id) ?? null
  );

  let mediaItems = $derived(
    standaloneMediaItem
      ? [standaloneMediaItem]
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
  const roomSession = new RoomSession(core.commands, pinnedEvents);
  providePinnedEvents(pinnedEvents);
  onDestroy(() => roomSession.dispose());

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

  function trackTimelineHeight(node: HTMLElement): () => void {
    const observer = new ResizeObserver(() => {
      timelineHeight = node.clientHeight;
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
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
    void core.commands
      .eventSource(targetRoomId, targetEventId)
      .then((source) => {
        if (!active) return;
        const relation = notifiedRelation(source);
        const rootEventId = relation?.thread ? relation.eventId : null;
        permalinkTarget = { roomId: targetRoomId, eventId: targetEventId, rootEventId };
        if (rootEventId !== null) untrack(() => openThread(rootEventId, targetEventId));
        else untrack(closeThread);
      })
      .catch((error: unknown) => {
        if (!active) return;
        permalinkTarget = { roomId: targetRoomId, eventId: targetEventId, rootEventId: null };
        untrack(closeThread);
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
    core.commands
      .eventSource(target, eventId)
      .then((source) => {
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
  let resolvedPermalink = $derived(
    permalinkTarget?.roomId === resolvedRoomId && permalinkTarget.eventId === eventId
      ? permalinkTarget
      : null
  );
  let timelineEventId = $derived(resolvedPermalink?.rootEventId ?? eventId);
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
  let voiceChatWidth = $state(VOICE_CHAT_DEFAULT_WIDTH);
  let callShown = $derived(call.roomId === resolvedRoomId && (call.active || call.failure));
  let roomName = $derived(resolvedRoom ? roomLabel(resolvedRoom) : roomId);
  let roomAvatar = $derived(resolvedRoom?.avatar_url ?? null);
  let roomTopic = $derived(resolvedRoom?.topic ?? null);
  let isTombstoned = $derived(resolvedRoom?.is_tombstoned ?? false);
  let tombstoneSuccessor = $derived(
    roomSession.tombstoneReplacementId
      ? findRoomByPathId(roomList.rooms, roomSession.tombstoneReplacementId)
      : null
  );
  let tombstoneSuccessorJoined = $derived(tombstoneSuccessor?.state === 'joined');

  const abbreviations = new RoomAbbreviations(core.commands);
  provideRoomAbbreviations(abbreviations);
  const mediaPreviews = new RoomMediaPreviews(() => resolvedRoom?.join_rule ?? null);
  provideRoomMediaPreviews(mediaPreviews);
  provideMediaViewerOpener(openStandaloneMedia);
  $effect(() => {
    void mediaPreviews.load(resolvedRoomId);
  });
  provideRoomMemberNames({ displayName: memberDisplayName });
  let senderRoles = $derived.by((): Record<string, SenderRole> => {
    const tags = roomSession.powerTags;
    if (!tags || !Object.values(tags).some((tag) => tag.icon || tag.color)) return {};
    return Object.fromEntries(
      memberLoader.members.flatMap((member) => {
        const icon = tagForLevel(tags, member.power_level)?.icon ?? null;
        const color = powerTag(member.power_level, $i18n.t, tags).color;
        return icon || color ? [[member.user_id, { icon, color }]] : [];
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
      .filter((room) => room.state === 'joined' && !room.is_space)
      .reduce((total, room) => total + roomList.notificationsFor(room).highlight, 0)
  );
  let pageTitle = $derived(
    mentionCount > 0 ? `(${mentionCount}) ${roomName} - Sable` : `${roomName} - Sable`
  );
  const sidePanels = createMediaQuery(BREAKPOINTS.sidePanels);
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let phone = $derived(!appLayout.matches);
  let pinsOpen = $state(false);
  let pinsUnread = $state(0);
  let desktop = $derived(sidePanels.matches);
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
    conversation.forgetRequestedDetails();
    receiptsOpen = false;
    panels.reset();
    closeProfile();
  });

  $effect(() => {
    roomSession.sync(resolvedRoomId, isTombstoned, memberListChanges.version);
  });

  $effect(() => {
    void resolvedRoomId;
    void isTombstoned;
    tombstoneJoinFailed = false;
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
  let openedRoomId: string | null = null;
  let timelineRoomId = $derived(resolvedRoom?.room_id);
  let roomHasUnread = $derived(
    (resolvedRoom?.unread ?? 0) > 0 ||
      (resolvedRoom?.highlight ?? 0) > 0 ||
      (resolvedRoom?.marked_unread ?? false)
  );

  $effect(() => {
    // Waiting for the target to have been applied matters as much as waiting
    // for live mode. Restarting the timeline is async, so at the moment of a
    // jump the mode is still `live` and this would strip the anchor straight
    // back off the URL, undoing the navigation before it takes effect.
    if (eventId === null || eventId !== appliedEventId) return;
    if (resolvedPermalink === null || resolvedPermalink.rootEventId !== null) return;
    if (!timelineFollowingLive || timeline.mode.kind !== 'live') return;
    void goto(roomUrl(null), { replace: true, reset: false });
  });

  $effect(() => {
    const activeRoomId = timelineRoomId;
    if (!activeRoomId) return;
    if (eventId !== null && resolvedPermalink === null) return;
    const targetEventId = timelineEventId;
    const anchor = untrack(() => {
      // An event already in the loaded range is reached by scrolling, so only a
      // target we do not hold restarts the timeline in permalink mode. That
      // only holds while live: dropping the anchor from a focused timeline
      // restarts it at the present instead of moving within the loaded window.
      const loaded = timeline.items.some((item) => item.event_id === targetEventId);
      return loaded && timeline.mode.kind === 'live' ? null : targetEventId;
    });
    appliedEventId = eventId;
    const openAtUnread = untrack(() => {
      if (openedRoomId === activeRoomId) return false;
      openedRoomId = activeRoomId;
      return eventId === null && notifiedEventId === null && roomHasUnread;
    });
    // Read outside `untrack`: the toggle only takes effect by re-subscribing.
    const hiddenEvents = preferences.showHiddenEvents;
    void untrack(() =>
      activeTimeline.start(timelineOwner, activeRoomId, anchor, hiddenEvents, openAtUnread)
    );
    void untrack(() => loadMembers());
  });

  async function loadMembers(): Promise<void> {
    const activeRoomId = resolvedRoomId;
    await memberLoader.load(activeRoomId, (roomId) => core.commands.roomMembers(roomId));
  }

  let memberChangeKey = $derived.by(() => {
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const { content, event_id: eventId } = timeline.items[index];
      if (eventId && (content.kind === 'membership' || content.kind === 'profile_change')) {
        return eventId;
      }
    }
    return null;
  });

  $effect(() => {
    if (memberChangeKey === null) return;
    const activeRoomId = untrack(() => resolvedRoomId);
    void untrack(() =>
      memberLoader.refresh(activeRoomId, (roomId) => core.commands.roomMembers(roomId))
    );
  });

  function loadMembership(membership: MembershipView): Promise<MemberView[]> {
    return core.commands.roomMembers(resolvedRoomId, [membership]);
  }

  function toggleMembers(): void {
    if (panels.toggleMembers(desktop)) void loadMembers();
  }

  function closeMembers(): void {
    panels.closeMembers(desktop);
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

  function closeWidgets(): void {
    panels.widgetsOpen = false;
  }

  async function addWidget(name: string, url: string): Promise<void> {
    try {
      await roomSession.details.addWidget(name, url, core.session?.user_id ?? '');
    } catch (error) {
      console.warn('[sable room] add widget failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  async function removeWidget(widgetId: string): Promise<void> {
    try {
      await roomSession.details.removeWidget(widgetId);
    } catch (error) {
      console.warn('[sable room] remove widget failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
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
    void afterOverlayPops().then(() => goto(target));
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
    void activeTimeline.start(timelineOwner, resolvedRoomId, null, preferences.showHiddenEvents);
    void goto(roomUrl(null), { replace: true });
  }

  // A history entry, so back is a way out of the anchor.
  function jumpToEvent(eventId: string): void {
    if (eventId === page.url.searchParams.get('event')) {
      timelineList?.jumpToEvent(eventId);
      return;
    }
    const target = roomUrl(eventId);
    void afterOverlayPops().then(() => goto(target, { reset: false }));
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
    void markAllRead().catch((error: unknown) => {
      console.warn('[sable room] mark as read failed', error);
    });
  }

  async function markAllRead(): Promise<void> {
    const list = timelineList;
    await core.commands.markRead(resolvedRoomId, null, readReceiptIsPrivate());
    list?.dismissUnread();
  }

  async function loadReadMarker(): Promise<string | null> {
    const content = await core.commands.roomAccountData(resolvedRoomId, 'm.fully_read');
    const eventId = (content as { event_id?: unknown } | null)?.event_id;
    return typeof eventId === 'string' ? eventId : null;
  }

  function requestUnread(eventId: string): Promise<void> {
    return activeTimeline.startUnread(
      timelineOwner,
      resolvedRoomId,
      eventId,
      preferences.showHiddenEvents
    );
  }

  function resumeLive(anchor?: ResumeAnchor): Promise<void> {
    return activeTimeline.resumeLive(timelineOwner, anchor);
  }

  function markRoomUnread(): void {
    void core.commands.markUnread(resolvedRoomId).catch((error: unknown) => {
      console.warn('[sable room] mark as unread failed', error);
    });
  }

  function openMedia(eventId: string): void {
    standaloneMediaItem = null;
    panelMediaItems = null;
    mediaEventId = eventId;
  }

  function openPanelMedia(items: MediaItem[], eventId: string): void {
    standaloneMediaItem = null;
    panelMediaItems = items;
    mediaEventId = eventId;
  }

  function jumpFromViewer(eventId: string): void {
    closeMedia();
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
    openStandaloneMedia({
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
      animated: null,
      sender: displayName,
    });
  }

  function openStandaloneMedia(item: StandaloneMedia): void {
    panelMediaItems = null;
    const standalone = { ...item, eventId: `standalone-${String(++standaloneSequence)}` };
    standaloneMediaItem = standalone;
    mediaEventId = standalone.eventId;
  }

  function closeMedia(): void {
    mediaEventId = null;
    standaloneMediaItem = null;
    panelMediaItems = null;
  }

  function tombstoneSuccessorPath(id: string, isSpace: boolean): string {
    const param = roomPathParamFromId(id);
    return isSpace
      ? resolve('/(app)/space/[spaceId]', { spaceId: param })
      : resolve('/(app)/rooms/[roomId]', { roomId: param });
  }

  function openTombstoneSuccessor(): void {
    if (!roomSession.tombstoneReplacementId) return;
    const isSpace = tombstoneSuccessor?.is_space ?? resolvedRoom?.is_space ?? false;
    void goto(tombstoneSuccessorPath(roomSession.tombstoneReplacementId, isSpace));
  }

  async function joinTombstoneSuccessor(): Promise<void> {
    const target = roomSession.tombstoneReplacementId;
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
    if (!roomSession.predecessor) return;
    void goto(
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
      active={panels.threadRootId === null || threadInPanel}
      focusEventId={timelineEventId}
      {landingEventId}
      onLanded={landed}
      onRequestHistory={requestHistory}
      onRequestFuture={requestFuture}
      onRead={markRead}
      hasUnread={resolvedRoom === undefined || roomHasUnread}
      onLoadReadMarker={loadReadMarker}
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
        body={roomSession.tombstoneBody}
        resolved={roomSession.tombstoneChecked}
        successorId={roomSession.tombstoneReplacementId}
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
      {/key}
    {/if}
  </div>
{/snippet}

<main
  class="room-view"
  aria-label={$i18n.t('timeline.label')}
  data-inset-owner={voiceView ? 'top' : 'top bottom'}
>
  <div
    class="timeline"
    class:thread-covered={panels.threadRootId !== null && !threadInPanel}
    inert={panels.threadRootId !== null && !threadInPanel}
    {@attach trackTimelineHeight}
  >
    {#snippet headerActions()}
      {#if !voiceView}
        <PanelHeaderButton
          label={$i18n.t('timeline.threadsOpen')}
          aria-pressed={panels.threadsOpen}
          onclick={toggleThreads}
        >
          <ChatsIcon weight={panels.threadsOpen ? 'fill' : 'regular'} />
        </PanelHeaderButton>
        {#if desktop}
          <PanelHeaderButton
            label={$i18n.t('timeline.attachmentsOpen')}
            aria-pressed={panels.attachmentsOpen}
            onclick={toggleAttachments}
          >
            <ImagesIcon weight={panels.attachmentsOpen ? 'fill' : 'regular'} />
          </PanelHeaderButton>
        {/if}
      {/if}
      {#if roomSession.widgets.length > 0 || canManageWidgets}
        <PanelHeaderButton
          label={$i18n.t('widgets.label')}
          aria-pressed={panels.widgetsOpen}
          onclick={toggleWidgets}
        >
          <span class="widgets-button-icon">
            <GridFourIcon weight={panels.widgetsOpen ? 'fill' : 'regular'} />
            {#if roomSession.widgets.length > 0}
              <span class="widgets-count" aria-hidden="true">{roomSession.widgets.length}</span>
            {/if}
          </span>
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
      <div
        class="call-stage"
        class:docked={!voiceView}
        style:flex-basis={voiceView ? undefined : `${callStageRatio * 100}%`}
      >
        {#await import('#lib/features/call/CallView.svelte') then { default: CallView }}
          <CallView
            session={call}
            members={memberLoader.members}
            onInvite={roomSession.permissions?.can_invite ? () => (inviteOpen = true) : undefined}
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
        onCopyLink={copyEventLink}
      />
    {/key}
  {/if}

  {#if voiceChatBeside}
    <aside
      class:thread-covered={panels.threadRootId !== null && !threadInPanel}
      inert={panels.threadRootId !== null && !threadInPanel}
      class="voice-chat"
      style:width="{voiceChatWidth}px"
      aria-label={$i18n.t('call.chat')}
    >
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
            onclick={() => (voiceChat.open = false)}
          >
            <XIcon />
          </PanelHeaderButton>
        {/snippet}
      </PanelHeader>
      {@render chat()}
    </aside>
  {/if}

  {#if panels.threadsOpen}
    <ThreadList
      roomId={resolvedRoomId}
      members={memberLoader.members}
      modal={!desktop}
      onOpenThread={openThread}
      onClose={() => (panels.threadsOpen = false)}
    />
  {/if}

  {#if panels.searchOpen}
    {#key resolvedRoomId}
      <RoomSearchPanel
        query={scopedSearchQuery('in', resolvedRoom, resolvedRoomId)}
        onClose={() => (panels.searchOpen = false)}
      />
    {/key}
  {/if}

  {#if panels.attachmentsOpen}
    <RoomAttachments
      roomId={resolvedRoomId}
      members={memberLoader.members}
      modal={!desktop}
      onJump={jumpToEvent}
      onOpenMedia={openPanelMedia}
      onMatrixLink={handleMatrixLink}
      onClose={() => (panels.attachmentsOpen = false)}
    />
  {/if}

  {#if desktop}
    {#if panels.desktopMembersOpen && panels.threadRootId === null}
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        powerTags={roomSession.powerTags}
        alwaysListedFrom={roomSession.alwaysListedFrom}
        {loadMembership}
        onClose={closeMembers}
        onMemberProfile={openProfile}
      />
    {/if}
    {#if panels.widgetsOpen}
      <WidgetsPanel
        roomId={resolvedRoomId}
        widgets={roomSession.widgets}
        userId={core.session?.user_id ?? ''}
        displayName={ownMember?.display_name ?? core.session?.user_id ?? ''}
        avatarUrl={ownMember?.avatar_url ?? ''}
        canManage={canManageWidgets}
        onClose={closeWidgets}
        onAdd={addWidget}
        onRemove={removeWidget}
      />
    {/if}
  {:else}
    <DialogFrame bind:open={panels.membersOpen} variant="drawer">
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        modal
        powerTags={roomSession.powerTags}
        alwaysListedFrom={roomSession.alwaysListedFrom}
        {loadMembership}
        onClose={closeMembers}
        onMemberProfile={openProfile}
      />
    </DialogFrame>
  {/if}

  {#if !desktop}
    <DialogFrame
      open={panels.widgetsOpen}
      onOpenChange={(open: boolean) => {
        if (!open) closeWidgets();
      }}
      variant="drawer"
    >
      <WidgetsPanel
        roomId={resolvedRoomId}
        widgets={roomSession.widgets}
        userId={core.session?.user_id ?? ''}
        displayName={ownMember?.display_name ?? core.session?.user_id ?? ''}
        avatarUrl={ownMember?.avatar_url ?? ''}
        canManage={canManageWidgets}
        modal
        onClose={closeWidgets}
        onAdd={addWidget}
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

  <MessageReportDialog
    bind:open={reportOpen}
    title={$i18n.t(resolvedRoom?.is_space ? 'room.reportSpaceTitle' : 'room.reportTitle')}
    hint={$i18n.t('room.reportHint')}
    onReport={(reason) => {
      const target = resolvedRoomId;
      void sendReport(() => core.commands.reportRoom(target, reason ?? ''));
    }}
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
    onMatrixLink={handleMatrixLink}
    onPowerLevelChange={(target, userId, level) => {
      memberLoader.setPowerLevel(target, userId, level);
    }}
    onOpenMainAccount={() => {
      if (memberProfile.userId && memberProfile.anchor) {
        openProfile(memberProfile.userId, memberProfile.anchor);
      }
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
  .widgets-button-icon {
    display: inline-flex;
    position: relative;
  }

  .widgets-button-icon > :global(svg) {
    height: var(--button-icon-size);
    width: var(--button-icon-size);
  }

  .widgets-count {
    align-items: center;
    background: var(--sec-main);
    border-radius: var(--radii-pill);
    color: var(--sec-on-main);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    height: var(--size-x50);
    inset-block-start: calc(var(--space-100) * -1);
    inset-inline-start: calc(var(--space-100) * -1);
    justify-content: center;
    min-width: var(--size-x50);
    padding: 0 var(--space-100);
    pointer-events: none;
    position: absolute;
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

  .timeline.thread-covered,
  .voice-chat.thread-covered {
    inset: 0;
    pointer-events: none;
    position: absolute;
    visibility: hidden;
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
