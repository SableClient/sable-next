<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { ProfileView } from '#src/generated/ProfileView';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import type { OutgoingMentions } from '#lib/core/client.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { matrixToUrl, roomSectionPath } from '#lib/rooms/permalink.js';
  import {
    findRoomByPathId,
    roomPathParamFromId,
    useRoomList,
  } from '#lib/rooms/room-list.svelte.js';
  import { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import { activeRoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import RoomComposer from '#lib/features/composer/RoomComposer.svelte';
  import type { ComposerContext } from '#lib/features/composer/composer-context.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MembersDrawer from './MembersDrawer.svelte';
  import MentionProfile from './MentionProfile.svelte';
  import RoomHeader from './RoomHeader.svelte';
  import RoomReadReceipts from './RoomReadReceipts.svelte';
  import RoomSettingsDialog from './RoomSettingsDialog.svelte';
  import TimelineList from './TimelineList.svelte';
  import MediaViewer from './MediaViewer.svelte';
  import { splitVia } from './join-address';
  import type { MatrixLink } from './matrix-link';
  import { initials } from './timeline-format';

  interface Props {
    roomId: string;
    eventId?: string | null;
  }

  let { roomId, eventId = null }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const timelineOwner = Symbol('room-view');
  const activeTimeline = activeRoomTimeline(core);
  const timeline = activeTimeline.timeline;
  const memberLoader = new RoomMemberLoader();
  let membersOpen = $state(false);
  let desktopMembersOpen = $state(true);
  let profileOpen = $state(false);
  let receiptsOpen = $state(false);
  let profileUserId = $state<string | null>(null);
  let profileAnchor = $state<HTMLElement | null>(null);
  let profile = $state<ProfileView | null>(null);
  let profileFailed = $state(false);
  let composerContext = $state<ComposerContext | null>(null);
  let profileRequestId = 0;
  let permissions = $state<RoomPermissionsView | null>(null);
  let settingsOpen = $state(false);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only the prefetch effect touches it, and a reactive set would make that effect invalidate itself
  const requestedDetails = new Set<string>();
  let typingUserIds = $state.raw<string[]>([]);
  let timelineAtBottom = $state(true);
  let timelineFollowingLive = $state<boolean>(false);
  let mediaEventId = $state<string | null>(null);

  let mediaItems = $derived(
    timeline.items.flatMap((entry) => {
      if (!entry.event_id || (entry.content.kind !== 'image' && entry.content.kind !== 'sticker'))
        return [];

      return [
        {
          ...entry.content,
          eventId: entry.event_id,
          sender: entry.sender_name ?? entry.sender ?? 'Unknown sender',
        },
      ];
    })
  );
  let latestReadBy = $derived.by(() => {
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
    requestedDetails.clear();
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
    void core
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
    if (desktop && desktopMembersOpen) void loadMembers();
  });

  // The SDK loads a replied-to event lazily, so a reply preview stays blank
  // until it is asked for.
  $effect(() => {
    const activeRoomId = resolvedRoomId;
    for (const item of timeline.items) {
      const reply = item.in_reply_to;
      if (!reply || reply.body !== null) continue;
      // Asked for by the id of the reply, not of the event it replies to.
      const eventId = item.event_id;
      if (eventId === null || requestedDetails.has(eventId)) continue;

      requestedDetails.add(eventId);
      void core.fetchEventDetails(activeRoomId, eventId).catch((error: unknown) => {
        console.debug('[sable room] reply details unavailable', error);
      });
    }
  });

  $effect(() => {
    if (latestReadBy.length > 0) void loadMembers();
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
    const activeRoomId = roomId.startsWith('!') ? roomId : resolvedRoom?.room_id;
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
  });

  async function loadMembers(): Promise<void> {
    const activeRoomId = resolvedRoomId;
    await memberLoader.load(activeRoomId, (roomId) => core.roomMembers(roomId));
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

  function closeProfile(): void {
    profileRequestId += 1;
    profileOpen = false;
    profileUserId = null;
    profileAnchor = null;
    profile = null;
    profileFailed = false;
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
      const via = alias ? [] : await core.roomViaServers(resolvedRoomId);
      await navigator.clipboard.writeText(matrixToUrl(alias ?? resolvedRoomId, via, eventId));
    } catch (error) {
      console.debug('[sable room] copy link failed', error);
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
    void goto(resolve('home'));
  }

  async function sendMessage(
    targetRoomId: string,
    body: string,
    formatted: string | null = null,
    mentions: OutgoingMentions = { userIds: [], room: false }
  ): Promise<void> {
    const pending = composerContext;
    if (body === '') return;

    if (pending?.kind === 'edit') {
      await core.editMessage(targetRoomId, pending.eventId, body, formatted, mentions);
    } else {
      await core.sendMessage(targetRoomId, body, pending?.eventId ?? null, formatted, mentions);
    }
    composerContext = null;
  }

  // The reply relation belongs to the first event of a send, which is an
  // attachment whenever there is one.
  async function sendAttachment(
    targetRoomId: string,
    file: File,
    options: { caption?: string } = {}
  ): Promise<void> {
    const replyTo = composerContext?.kind === 'reply' ? composerContext.eventId : null;
    await core.sendAttachment(targetRoomId, file, { caption: options.caption, inReplyTo: replyTo });
    if (replyTo !== null) composerContext = null;
  }

  async function sendSticker(targetRoomId: string, url: string, body: string): Promise<void> {
    await core.sendSticker(targetRoomId, url, body);
  }

  async function createPoll(
    targetRoomId: string,
    question: string,
    answers: string[],
    undisclosed: boolean
  ): Promise<void> {
    await core.createPoll(targetRoomId, question, answers, undisclosed);
  }

  async function setTyping(targetRoomId: string, typing: boolean): Promise<void> {
    if (!preferences.sendTypingNotifications) return;
    await core.setTyping(targetRoomId, typing);
  }

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  async function markRead(eventId: string): Promise<void> {
    if (!preferences.sendReadReceipts) return;
    await core.markRead(resolvedRoomId, eventId);
  }

  function onRetrySend(transactionId: string): void {
    void core.retrySend(resolvedRoomId, transactionId);
  }

  function onCancelSend(transactionId: string): void {
    void core.cancelSend(resolvedRoomId, transactionId);
  }

  function onToggleReaction(eventId: string, key: string): void {
    void core.toggleReaction(resolvedRoomId, eventId, key);
  }

  function onVotePoll(eventId: string, answers: string[]): void {
    void core.votePoll(resolvedRoomId, eventId, answers);
  }

  function onEndPoll(eventId: string): void {
    void core.endPoll(resolvedRoomId, eventId);
  }

  function onDelete(eventId: string, reason: string | null): void {
    void core.redact(resolvedRoomId, eventId, reason);
  }

  function onReply(eventId: string): void {
    const item = timeline.items.find((entry) => entry.event_id === eventId);
    if (!item || (item.content.kind !== 'message' && item.content.kind !== 'image')) return;
    composerContext = {
      kind: 'reply',
      eventId,
      sender: item.sender_name ?? item.sender,
      body: item.content.body,
    };
  }

  function onEdit(eventId: string, body: string, html: string | null = null): void {
    composerContext = { kind: 'edit', eventId, body, html };
  }

  function editLastOwnMessage(): void {
    const userId = core.session?.user_id;
    if (!userId) return;

    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if (!item.event_id || item.sender !== userId) continue;
      if (item.content.kind !== 'message') continue;
      onEdit(item.event_id, item.content.body, item.content.html);
      return;
    }
  }

  function clearComposerContext(): void {
    composerContext = null;
  }

  function openMedia(eventId: string): void {
    mediaEventId = eventId;
  }
</script>

<main class="room-view" aria-label={$i18n.t('timeline.label')}>
  <div class="timeline">
    <RoomHeader
      {roomName}
      {roomAvatar}
      onBack={goBack}
      onMembers={toggleMembers}
      onSettings={() => (settingsOpen = true)}
      {initials}
    />
    {#key resolvedRoomId}
      <TimelineList
        {timeline}
        focusEventId={eventId}
        onRequestHistory={requestHistory}
        onRequestFuture={requestFuture}
        onRead={markRead}
        onMatrixLink={handleMatrixLink}
        onCopyLink={copyEventLink}
        onSenderProfile={openProfile}
        {onRetrySend}
        {onCancelSend}
        {onToggleReaction}
        {onDelete}
        {onReply}
        {onEdit}
        roomId={resolvedRoomId}
        members={memberLoader.members}
        onJumpToEvent={jumpToEvent}
        onOpenMedia={openMedia}
        {onVotePoll}
        {onEndPoll}
        readOnly={permissions ? !permissions.can_post : false}
        canRedactOthers={permissions?.can_redact_others ?? false}
        currentUserId={core.session?.user_id ?? null}
        scrollLocked={profileOpen || receiptsOpen}
        bind:nearLatest={timelineAtBottom}
        bind:followingLive={timelineFollowingLive}
      />
    {/key}
    <div class="composer-dock">
      {#key resolvedRoomId}
        <RoomComposer
          roomId={resolvedRoomId}
          onSend={sendMessage}
          onSendAttachment={sendAttachment}
          onSendSticker={sendSticker}
          onCreatePoll={createPoll}
          onTyping={setTyping}
          {typingLabel}
          {roomName}
          readOnly={permissions ? !permissions.can_post : false}
          context={composerContext}
          onCancelContext={clearComposerContext}
          onEditLast={editLastOwnMessage}
        >
          {#snippet statusTrailing()}
            {#if !preferences.hideReadReceipts}
              <RoomReadReceipts
                bind:open={receiptsOpen}
                readers={latestReadBy}
                members={receiptMembers}
                loading={memberLoader.loading}
                visible={timelineAtBottom}
                onMemberProfile={openProfile}
              />
            {/if}
          {/snippet}
        </RoomComposer>
      {/key}
    </div>
  </div>

  {#if desktop}
    {#if desktopMembersOpen}
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        onClose={closeMembers}
        onMemberProfile={openProfile}
      />
    {/if}
  {:else}
    <DialogFrame bind:open={membersOpen} variant="drawer">
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        modal
        onClose={closeMembers}
        onMemberProfile={openProfile}
      />
    </DialogFrame>
  {/if}

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

  /* Clears the navigation bar, and the soft keyboard where it overlays. */
  .composer-dock {
    flex: 0 0 auto;
    padding-bottom: var(--safe-bottom);
  }
</style>
