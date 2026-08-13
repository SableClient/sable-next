<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
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
  import RoomHeader from './RoomHeader.svelte';
  import TimelineList from './TimelineList.svelte';
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
  let typingUserIds = $state.raw<string[]>([]);

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

    return core.subscribeEvents((event) => {
      if (event.type !== 'typing' || event.room_id !== activeRoomId) return;
      typingUserIds = event.user_ids.filter((userId) => userId !== core.session?.user_id);
      if (typingUserIds.length > 0) void loadMembers();
    });
  });

  $effect(() => {
    if (desktop && desktopMembersOpen) void loadMembers();
  });

  $effect(() => {
    const activeRoomId = roomId.startsWith('!') ? roomId : resolvedRoom?.room_id;
    if (!activeRoomId) return;
    void untrack(() => activeTimeline.start(timelineOwner, activeRoomId, eventId));
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

  function typingMemberName(userId: string): string | null {
    return memberLoader.members.find((member) => member.user_id === userId)?.display_name ?? null;
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

  async function sendMessage(targetRoomId: string, body: string): Promise<void> {
    await core.sendMessage(targetRoomId, body);
  }

  async function sendImage(targetRoomId: string, image: File): Promise<void> {
    await core.sendImage(targetRoomId, image);
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
</script>

<section class="room-view" aria-label={$i18n.t('timeline.label')}>
  <div class="timeline">
    <RoomHeader {roomName} {roomAvatar} onBack={goBack} onMembers={toggleMembers} {initials} />
    {#key `${roomId}:${eventId ?? ''}`}
      <TimelineList
        {timeline}
        focusEventId={eventId}
        onRequestHistory={requestHistory}
        onRequestFuture={requestFuture}
        onRead={markRead}
      />
    {/key}
    <div class="typing-slot" aria-live="polite" role="status">
      {#if typingLabel}
        <div class="typing">
          <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>{typingLabel}</span>
        </div>
      {/if}
    </div>
    {#key resolvedRoomId}
      <RoomComposer
        roomId={resolvedRoomId}
        onSend={sendMessage}
        onSendImage={sendImage}
        onTyping={setTyping}
      />
    {/key}
  </div>

  {#if desktop}
    {#if desktopMembersOpen}
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        onClose={closeMembers}
      />
    {/if}
  {:else}
    <DialogFrame bind:open={membersOpen} variant="drawer">
      <MembersDrawer
        members={memberLoader.members}
        loading={memberLoader.loading}
        modal
        onClose={closeMembers}
      />
    </DialogFrame>
  {/if}
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

  .typing-slot {
    box-sizing: border-box;
    display: flex;
    flex: 0 0 1.25rem;
    min-width: 0;
    padding: 0 var(--page-gutter);
  }

  .typing {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.375rem;
    line-height: 1.25rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .typing-dots {
    display: inline-flex;
    gap: 0.1875rem;
  }

  .typing-dots i {
    background: var(--sable-primary-main);
    border-radius: 50%;
    height: 0.25rem;
    width: 0.25rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .typing-dots i {
      animation: typing-dot 1.2s infinite ease-in-out;
    }

    .typing-dots i:nth-child(2) {
      animation-delay: 0.15s;
    }

    .typing-dots i:nth-child(3) {
      animation-delay: 0.3s;
    }
  }

  @keyframes typing-dot {
    0%,
    60%,
    100% {
      opacity: 0.3;
      transform: translateY(0);
    }

    30% {
      opacity: 1;
      transform: translateY(-0.1875rem);
    }
  }
</style>
