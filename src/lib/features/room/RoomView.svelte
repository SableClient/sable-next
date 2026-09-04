<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { MemberView } from '#src/generated/MemberView';
  import type { MembershipView } from '#src/generated/MembershipView';
  import type { ProfileView } from '#src/generated/ProfileView';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import type { CallSupportView } from '#src/generated/CallSupportView';

  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { PinnedEvents, providePinnedEvents } from './pinned-events.svelte.js';
  import { useBookmarks } from './bookmarks.svelte.js';
  import { Conversation } from './conversation.svelte.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { parseRoomWidget, type RoomWidget } from '#lib/features/widgets/widget-content.js';
  import WidgetsPanel from '#lib/features/widgets/WidgetsPanel.svelte';
  import { matrixToUrl, roomSectionPath } from '#lib/rooms/permalink.js';
  import {
    findRoomByPathId,
    roomPathParamFromId,
    useRoomList,
  } from '#lib/rooms/room-list.svelte.js';
  import { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import { activeRoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import RoomComposer from '#lib/features/composer/RoomComposer.svelte';
  import ScheduledMessages from '#lib/features/composer/ScheduledMessages.svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { preferences, readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import CallDevicePreview from '#lib/features/call/CallDevicePreview.svelte';
  import { useCallSession, type CallMedia } from '#lib/features/call/call-session.svelte.js';
  import JumpToTimeDialog from './JumpToTimeDialog.svelte';
  import LeaveRoomDialog from './LeaveRoomDialog.svelte';
  import MembersDrawer from './MembersDrawer.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import MentionProfile from './MentionProfile.svelte';
  import RoomHeader from './RoomHeader.svelte';
  import RoomHeaderMenu from './RoomHeaderMenu.svelte';
  import RoomInviteDialog from './RoomInviteDialog.svelte';
  import RoomPinMenu from './RoomPinMenu.svelte';
  import RoomTombstoneBanner from './RoomTombstoneBanner.svelte';
  import RoomTopicViewer from './RoomTopicViewer.svelte';
  import RoomReadReceipts from './RoomReadReceipts.svelte';
  import RoomSettingsDialog from './RoomSettingsDialog.svelte';
  import TimelineList from './TimelineList.svelte';
  import MediaViewer from './MediaViewer.svelte';
  import { isPdfAttachment } from '#lib/ui/pdf-attachment.js';
  import {
    POWER_LEVEL_TAGS_EVENT_TYPE,
    parsePowerLevelTags,
    type PowerLevelTagMap,
  } from './settings/power-level-tags.js';
  import { readTombstone } from './settings/room-upgrade.js';
  import { splitVia } from './join-address';
  import type { MatrixLink } from './matrix-link';
  import { eventBefore, latestEventId } from './timeline-format';

  interface Props {
    roomId: string;
    eventId?: string | null;
  }

  let { roomId, eventId = null }: Props = $props();
  const core = useCoreClient();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const timelineOwner = Symbol('room-view');
  const activeTimeline = activeRoomTimeline(core);
  const timeline = activeTimeline.timeline;
  const memberLoader = new RoomMemberLoader();
  const call = useCallSession();
  let prescreenOpen = $state(false);
  let prescreenMedia = $state<CallMedia>({ microphone: true, camera: false });
  let membersOpen = $state(false);
  let desktopMembersOpen = $state(true);
  let composer = $state<RoomComposer>();
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
  });
  let profileRequestId = 0;
  let permissions = $state<RoomPermissionsView | null>(null);
  let powerTags = $state.raw<PowerLevelTagMap>({});
  let settingsOpen = $state(false);
  let topicOpen = $state(false);
  let inviteOpen = $state(false);
  let jumpOpen = $state(false);
  let leaveOpen = $state(false);
  let typingUserIds = $state.raw<string[]>([]);
  let timelineAtBottom = $state(true);
  let timelineFollowingLive = $state<boolean>(false);
  let mediaEventId = $state<string | null>(null);
  let callSupport = $state<CallSupportView | null>(null);
  let widgetsOpen = $state(false);
  let widgets = $state.raw<RoomWidget[]>([]);
  let tombstoneReplacementId = $state<string | null>(null);
  let tombstoneBody = $state<string | null>(null);
  let tombstoneChecked = $state(false);
  let tombstoneJoining = $state(false);
  let tombstoneJoinFailed = $state(false);

  let ownMember = $derived(
    memberLoader.members.find((member) => member.user_id === core.session?.user_id) ?? null
  );

  let mediaItems = $derived(
    timeline.items.flatMap((entry) => {
      const eventId = entry.event_id;
      if (eventId === null) return [];
      const content = entry.content;
      if (
        content.kind !== 'image' &&
        content.kind !== 'sticker' &&
        !(content.kind === 'file' && isPdfAttachment(content.mime, content.body))
      ) {
        return [];
      }

      return [
        {
          ...content,
          eventId,
          sender: entry.sender_name ?? entry.sender ?? 'Unknown sender',
        },
      ];
    })
  );
  let callable = $derived(
    !call.active && callSupport !== null && callSupport.has_focus && callSupport.can_join
  );

  $effect(() => {
    const target = resolvedRoomId;
    if (!target) return;

    let current = true;
    callSupport = null;
    if (typeof RTCPeerConnection === 'undefined') return;

    void core.commands
      .callSupport(target)
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
    void pinRevision;
    const target = resolvedRoomId;
    if (target) void pinnedEvents.load(target);
  });

  const bookmarks = useBookmarks();
  let threadRootId = $state<string | null>(null);

  function openThread(rootEventId: string): void {
    threadRootId = rootEventId;
    desktopMembersOpen = false;
  }

  function closeThread(): void {
    threadRootId = null;
  }
  onMount(() => {
    void bookmarks.load();
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

  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  let roomName = $derived(resolvedRoom?.name ?? roomId);
  let roomAvatar = $derived(resolvedRoom?.avatar_url ?? null);
  let roomTopic = $derived(resolvedRoom?.topic ?? null);
  let isTombstoned = $derived(resolvedRoom?.is_tombstoned ?? false);
  let tombstoneSuccessor = $derived(
    tombstoneReplacementId ? findRoomByPathId(roomList.rooms, tombstoneReplacementId) : null
  );
  let tombstoneSuccessorJoined = $derived(tombstoneSuccessor?.state === 'joined');
  let mentionCount = $derived(
    roomList.rooms
      .filter((room) => room.state === 'joined' && !room.is_space)
      .reduce((total, room) => total + room.highlight, 0)
  );
  let pageTitle = $derived(
    mentionCount > 0 ? `(${mentionCount}) ${roomName} - Sable` : `${roomName} - Sable`
  );
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
  let typingLabel = $derived.by(() => {
    if (preferences.hideTypingIndicators || typingUserIds.length === 0) return null;
    const names = typingUserIds.slice(0, 3).map(typingMemberName);
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
    const activeRoomId = resolvedRoomId;
    memberLoader.reset();
    typingUserIds = [];
    conversation.forgetRequestedDetails();
    receiptsOpen = false;
    closeProfile();

    return core.subscribeEvents((event) => {
      if (event.type !== 'typing' || event.room_id !== activeRoomId) return;
      typingUserIds = event.user_ids.filter((userId) => userId !== core.session?.user_id);
      if (typingUserIds.length > 0) void loadMembers();
    });
  });

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    permissions = null;
    let current = true;
    void core.commands
      .roomPermissions(activeRoomId)
      .then((next) => {
        if (current) permissions = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] permissions unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    powerTags = {};
    let current = true;
    void core.commands
      .roomStateEvent(activeRoomId, POWER_LEVEL_TAGS_EVENT_TYPE)
      .then((content) => {
        if (current) powerTags = parsePowerLevelTags(content);
      })
      .catch((error: unknown) => {
        console.debug('[sable room] power level tags unavailable', error);
      });
    return () => {
      current = false;
    };
  });

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
    const activeRoomId = resolvedRoomId;
    widgets = [];
    let current = true;
    void loadWidgets(activeRoomId)
      .then((next) => {
        if (current) widgets = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] widgets unavailable', error);
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
    void goto(roomUrl(null), { replaceState: true, reset: false });
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

  async function loadWidgets(activeRoomId: string): Promise<RoomWidget[]> {
    const events = await core.commands.roomStateEvents(activeRoomId, 'im.vector.modular.widgets');
    return events.flatMap((event) => {
      const widget = parseRoomWidget(event.state_key, event.content);
      return widget ? [widget] : [];
    });
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

  function openSearch(): void {
    const label = resolvedRoom?.canonical_alias ?? resolvedRoom?.name ?? resolvedRoomId;
    const scope = label.includes(' ') ? `"${label}"` : label;
    const target = `${resolve('/(app)/search')}?q=${encodeURIComponent(`in:${scope} `)}`;

    goto(target).catch(() => {
      window.location.assign(target);
    });
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
    try {
      const alias = resolvedRoom?.canonical_alias ?? null;
      const via = alias ? [] : await core.commands.roomViaServers(resolvedRoomId);
      await navigator.clipboard.writeText(matrixToUrl(alias ?? resolvedRoomId, via, eventId));
    } catch (error) {
      console.debug('[sable room] copy link failed', error);
      toasts.error($i18n.t('errors.copyFailed'));
    }
  }

  function typingMemberName(userId: string): string | null {
    return memberLoader.members.find((member) => member.user_id === userId)?.display_name ?? null;
  }

  /** RoomPage is mounted by the home, direct and space routes alike, so the
      current path has to survive the rewrite. */
  function roomUrl(eventId: string | null): string {
    const url = new URL(page.url.href);
    if (eventId === null) url.searchParams.delete('event');
    else url.searchParams.set('event', eventId);
    return `${url.pathname}${url.search}`;
  }

  // A history entry, so back is a way out of the anchor.
  function jumpToEvent(eventId: string): void {
    void goto(roomUrl(eventId), { reset: false });
  }

  function goBack(): void {
    if (page.url.pathname.startsWith('/direct/')) {
      void goto(resolve('direct'));
      return;
    }
    if (page.url.pathname.startsWith('/space/') && page.params.spaceId) {
      void goto(
        resolve('/(app)/space/[spaceId]', {
          spaceId: roomPathParamFromId(page.params.spaceId),
        })
      );
      return;
    }
    void goto(resolve('/(app)/rooms'));
  }

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  async function markRead(eventId: string): Promise<void> {
    await core.commands.markRead(resolvedRoomId, eventId, readReceiptIsPrivate());
  }

  function markUnreadFrom(eventId: string): void {
    void core.commands
      .markUnread(resolvedRoomId, eventBefore(timeline.items, eventId))
      .catch((error: unknown) => {
        console.warn('[sable room] mark as unread failed', error);
      });
  }

  function markRoomRead(): void {
    const newest = latestEventId(timeline.items);
    if (!newest) return;
    void core.commands
      .markRead(resolvedRoomId, newest, readReceiptIsPrivate())
      .catch((error: unknown) => {
        console.warn('[sable room] mark as read failed', error);
      });
  }

  function openMedia(eventId: string): void {
    mediaEventId = eventId;
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
      const alias = resolvedRoom?.canonical_alias ?? null;
      const via = alias ? [] : await core.commands.roomViaServers(resolvedRoomId);
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

  function openPrescreen(): void {
    call.clearFailure();
    prescreenMedia = { microphone: true, camera: resolvedRoom?.is_voice === false };
    prescreenOpen = true;
  }

  async function joinCall(): Promise<void> {
    if (!resolvedRoomId) return;
    try {
      await call.join(resolvedRoomId, prescreenMedia);
    } finally {
      prescreenOpen = false;
    }
  }
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

<main class="room-view" aria-label={$i18n.t('timeline.label')}>
  <div class="timeline">
    {#snippet widgetsButton()}
      {#if widgets.length > 0}
        <IconButton
          variant="ghost"
          size="small"
          label={$i18n.t('widgets.label')}
          onclick={toggleWidgets}
        >
          <GridFourIcon />
        </IconButton>
      {/if}
    {/snippet}
    <RoomHeader
      {roomName}
      {roomAvatar}
      topic={roomTopic}
      isVoice={resolvedRoom?.is_voice ?? false}
      callParticipants={resolvedRoom?.call_participants ?? []}
      members={memberLoader.members}
      membersOpen={desktop ? desktopMembersOpen : membersOpen}
      onCall={callable ? openPrescreen : null}
      onBack={goBack}
      onMembers={toggleMembers}
      onSearch={openSearch}
      onTopic={() => (topicOpen = true)}
      widgets={widgetsButton}
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
          onInvite={() => (inviteOpen = true)}
          onMembers={toggleMembers}
          onSettings={() => (settingsOpen = true)}
          onJumpToTime={() => (jumpOpen = true)}
          onLeave={() => (leaveOpen = true)}
        />
      {/snippet}
    </RoomHeader>
    {#if call.roomId === resolvedRoomId && (call.active || call.failure)}
      {#await import('#lib/features/call/CallView.svelte') then { default: CallView }}
        <CallView session={call} members={memberLoader.members} />
      {/await}
    {/if}
    {#key resolvedRoomId}
      <TimelineList
        {timeline}
        focusEventId={eventId}
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
        onToggleReaction={conversation.toggleReaction}
        onDelete={conversation.redact}
        onReply={conversation.reply}
        onOpenThread={openThread}
        onEdit={conversation.edit}
        roomId={resolvedRoomId}
        members={memberLoader.members}
        onJumpToEvent={jumpToEvent}
        onOpenMedia={openMedia}
        onVotePoll={conversation.votePoll}
        onEndPoll={conversation.endPoll}
        readOnly={permissions ? !permissions.can_post : false}
        canRedactOthers={permissions?.can_redact_others ?? false}
        currentUserId={core.session?.user_id ?? null}
        scrollLocked={profileOpen || receiptsOpen}
        {typingLabel}
        bind:nearLatest={timelineAtBottom}
        bind:followingLive={timelineFollowingLive}
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
    <div class="composer-dock">
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
          <ScheduledMessages roomId={resolvedRoomId} />
          <RoomComposer
            bind:this={composer}
            roomId={resolvedRoomId}
            onSend={conversation.sendMessage}
            onSendAttachment={conversation.sendAttachment}
            onSendSticker={conversation.sendSticker}
            onSendGif={conversation.sendGif}
            onCreatePoll={conversation.createPoll}
            onSendLocation={conversation.sendLocation}
            onSchedule={conversation.schedule}
            onTyping={conversation.setTyping}
            {roomName}
            readOnly={permissions ? !permissions.can_post : false}
            context={conversation.context}
            onCancelContext={conversation.clearContext}
            onEditLast={conversation.editLast}
          />
        {/key}
      {/if}
    </div>
  </div>

  {#if desktop}
    {#if threadRootId !== null}
      {#key threadRootId}
        <ThreadPanel
          roomId={resolvedRoomId}
          rootEventId={threadRootId}
          {roomName}
          members={memberLoader.members}
          readOnly={permissions ? !permissions.can_post : false}
          canRedactOthers={permissions?.can_redact_others ?? false}
          onClose={closeThread}
          onSenderProfile={openProfile}
          onCopyLink={copyEventLink}
          onOpenMedia={openMedia}
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
        canManage={permissions?.can_change_settings ?? false}
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
    <DialogFrame
      open={threadRootId !== null}
      onOpenChange={(open: boolean) => {
        if (!open) closeThread();
      }}
      variant="drawer"
    >
      {#if threadRootId !== null}
        {#key threadRootId}
          <ThreadPanel
            roomId={resolvedRoomId}
            rootEventId={threadRootId}
            {roomName}
            members={memberLoader.members}
            readOnly={permissions ? !permissions.can_post : false}
            canRedactOthers={permissions?.can_redact_others ?? false}
            modal
            onClose={closeThread}
            onSenderProfile={openProfile}
            onCopyLink={copyEventLink}
            onOpenMedia={openMedia}
          />
        {/key}
      {/if}
    </DialogFrame>
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
        canManage={permissions?.can_change_settings ?? false}
        modal
        onClose={closeWidgets}
        onRemove={removeWidget}
      />
    </DialogFrame>
  {/if}

  <DialogFrame bind:open={prescreenOpen} variant="sheet" label={$i18n.t('call.prescreenTitle')}>
    <CallDevicePreview
      media={prescreenMedia}
      joining={call.lifecycle === 'joining'}
      onChange={(media: CallMedia) => (prescreenMedia = media)}
      onJoin={() => void joinCall()}
      onCancel={() => (prescreenOpen = false)}
    />
  </DialogFrame>

  <RoomTopicViewer
    open={topicOpen}
    {roomName}
    topic={roomTopic ?? ''}
    onOpenChange={(open: boolean) => {
      topicOpen = open;
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
    onLeft={goBack}
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
    {profile}
    failed={profileFailed}
  />

  {#if mediaEventId}
    <MediaViewer
      items={mediaItems}
      selectedEventId={mediaEventId}
      onClose={() => (mediaEventId = null)}
    />
  {/if}
</main>

<style>
  .room-view {
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

  .composer-dock {
    flex: 0 0 auto;
    padding-bottom: var(--space-200);
  }
</style>
