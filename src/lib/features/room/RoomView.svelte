<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { ProfileView } from '@/generated/ProfileView';
  import type { RoomPermissionsView } from '@/generated/RoomPermissionsView';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { findRoomByPathId, roomPathParamFromId, useRoomList } from '$lib/rooms/room-list.svelte';
  import { RoomMemberLoader } from '$lib/rooms/room-members.svelte';
  import { activeRoomTimeline } from '$lib/rooms/timeline.svelte';
  import RoomComposer from '$lib/features/composer/RoomComposer.svelte';
  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';

  import MembersDrawer from './MembersDrawer.svelte';
  import MentionProfile from './MentionProfile.svelte';
  import RoomHeader from './RoomHeader.svelte';
  import RoomReadReceipts from './RoomReadReceipts.svelte';
  import TimelineList from './TimelineList.svelte';
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
  let profileUserId = $state<string | null>(null);
  let profileAnchor = $state<HTMLElement | null>(null);
  let profile = $state<ProfileView | null>(null);
  let profileFailed = $state(false);
  let composerContext = $state<{
    kind: 'reply' | 'edit';
    eventId: string;
    sender?: string | null;
    body: string;
  } | null>(null);
  let profileRequestId = 0;
  let permissions = $state<RoomPermissionsView | null>(null);
  let typingUserIds = $state.raw<string[]>([]);
  let timelineAtBottom = $state(true);
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
    if (typingUserIds.length === 0) return null;
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

  $effect(() => {
    if (latestReadBy.length > 0) void loadMembers();
  });

  $effect(() => {
    void roomId;
    timelineAtBottom = eventId === null;
  });

  $effect(() => {
    const activeRoomId = roomId.startsWith('!') ? roomId : resolvedRoom?.room_id;
    if (!activeRoomId) return;
    // An event already in the loaded range is reached by scrolling, so only a
    // target we do not hold restarts the timeline in permalink mode.
    const loaded = untrack(() => timeline.items.some((item) => item.event_id === eventId));
    const anchor = loaded ? null : eventId;
    void untrack(() => activeTimeline.start(timelineOwner, activeRoomId, anchor));
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

    const roomId = roomPathParamFromId(link.roomId);
    if (link.kind === 'event') {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- path is resolved; only the query is appended
      void goto(resolve('/(app)/home/[roomId]', { roomId }) + eventQuery(link.eventId));
      return;
    }
    void goto(resolve('/(app)/home/[roomId]', { roomId }));
  }

  function typingMemberName(userId: string): string | null {
    return memberLoader.members.find((member) => member.user_id === userId)?.display_name ?? null;
  }

  /** The event rides as a query param so a permalink or notification can carry
      it without a second route. */
  function eventQuery(eventId: string): string {
    return `?event=${encodeURIComponent(eventId)}`;
  }

  function jumpToEvent(eventId: string): void {
    const target =
      resolve('/(app)/home/[roomId]', { roomId: roomPathParamFromId(resolvedRoomId) }) +
      eventQuery(eventId);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- path is resolved; only the query is appended
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function goBack(): void {
    if (page.url.pathname.startsWith('/direct/')) {
      void goto(resolve('/direct'));
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
    void goto(resolve('/home'));
  }

  async function sendMessage(
    targetRoomId: string,
    body: string,
    formatted: string | null = null
  ): Promise<void> {
    const pending = composerContext;
    composerContext = null;
    if (pending?.kind === 'edit') {
      await core.editMessage(targetRoomId, pending.eventId, body, formatted);
      return;
    }
    await core.sendMessage(targetRoomId, body, pending?.eventId ?? null, formatted);
  }

  async function sendAttachment(targetRoomId: string, file: File): Promise<void> {
    await core.sendAttachment(targetRoomId, file);
  }

  async function sendSticker(targetRoomId: string, url: string, body: string): Promise<void> {
    await core.sendSticker(targetRoomId, url, body);
  }

  async function setTyping(targetRoomId: string, typing: boolean): Promise<void> {
    await core.setTyping(targetRoomId, typing);
  }

  function requestHistory(): Promise<boolean> {
    return timeline.paginateBackward(25);
  }

  async function requestFuture(): Promise<void> {
    await timeline.paginateForward(25);
  }

  async function markRead(eventId: string): Promise<void> {
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

  function onDelete(eventId: string, reason: string | null): void {
    void core.redact(resolvedRoomId, eventId, reason);
  }

  function onReply(eventId: string): void {
    const item = timeline.items.find((entry) => entry.event_id === eventId);
    if (!item || item.content.kind !== 'message') return;
    composerContext = {
      kind: 'reply',
      eventId,
      sender: item.sender_name ?? item.sender,
      body: item.content.body,
    };
  }

  function onEdit(eventId: string, body: string): void {
    composerContext = { kind: 'edit', eventId, body };
  }

  function editLastOwnMessage(): void {
    const userId = core.session?.user_id;
    if (!userId) return;

    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if (!item.event_id || item.sender !== userId) continue;
      if (item.content.kind !== 'message') continue;
      onEdit(item.event_id, item.content.body);
      return;
    }
  }

  function clearComposerContext(): void {
    composerContext = null;
  }
</script>

<section class="room-view" aria-label={$i18n.t('timeline.label')}>
  <div class="timeline">
    <RoomHeader {roomName} {roomAvatar} onBack={goBack} onMembers={toggleMembers} {initials} />
    {#key resolvedRoomId}
      <TimelineList
        {timeline}
        focusEventId={eventId}
        onRequestHistory={requestHistory}
        onRequestFuture={requestFuture}
        onRead={markRead}
        onMatrixLink={handleMatrixLink}
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
        readOnly={permissions ? !permissions.can_post : false}
        canRedactOthers={permissions?.can_redact_others ?? false}
        currentUserId={core.session?.user_id ?? null}
        scrollLocked={profileOpen}
        bind:nearLatest={timelineAtBottom}
      />
    {/key}
    <div class="composer-dock">
      {#key resolvedRoomId}
        <RoomComposer
          roomId={resolvedRoomId}
          onSend={sendMessage}
          onSendAttachment={sendAttachment}
          onSendSticker={sendSticker}
          onTyping={setTyping}
          {typingLabel}
          {roomName}
          context={composerContext}
          onCancelContext={clearComposerContext}
          onEditLast={editLastOwnMessage}
        >
          {#snippet statusTrailing()}
            <RoomReadReceipts
              readers={latestReadBy}
              members={receiptMembers}
              loading={memberLoader.loading}
              visible={timelineAtBottom}
              onMemberProfile={openProfile}
            />
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
    {profile}
    failed={profileFailed}
  />
</section>

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

  .composer-dock {
    flex: 0 0 auto;
  }
</style>
