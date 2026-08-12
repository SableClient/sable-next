<script lang="ts">
  import { Dialog } from 'bits-ui';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { findRoomByPathId, useRoomList } from '$lib/rooms/room-list.svelte';
  import { RoomMemberLoader } from '$lib/rooms/room-members.svelte';
  import { RoomTimeline } from '$lib/rooms/timeline.svelte';
  import RoomComposer from '$lib/features/composer/RoomComposer.svelte';

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
  const timeline = new RoomTimeline(core);
  let innerWidth = $state(0);
  const memberLoader = new RoomMemberLoader();
  let membersOpen = $state(false);
  let desktopMembersOpen = $state(true);
  let typingUserIds = $state.raw<string[]>([]);

  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  let roomName = $derived(resolvedRoom?.name ?? roomId);
  let desktop = $derived(innerWidth >= 768);
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
    const activeRoomId = resolvedRoomId;
    void timeline.start(activeRoomId, eventId);
    return () => {
      timeline.stop();
    };
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
    window.history.back();
  }

  async function sendMessage(targetRoomId: string, body: string): Promise<void> {
    await core.sendMessage(targetRoomId, body);
  }

  async function setTyping(targetRoomId: string, typing: boolean): Promise<void> {
    await core.setTyping(targetRoomId, typing);
  }

  async function requestHistory(): Promise<void> {
    await timeline.paginate(50);
  }

  async function markRead(eventId: string): Promise<void> {
    await core.markRead(resolvedRoomId, eventId);
  }
</script>

<svelte:window bind:innerWidth />

<section class="room-view" aria-label={$i18n.t('timeline.label')}>
  <div class="timeline">
    <RoomHeader {roomName} onBack={goBack} onMembers={toggleMembers} {initials} />
    {#key `${resolvedRoomId}:${eventId ?? ''}`}
      <TimelineList
        {timeline}
        focusEventId={eventId}
        onRequestHistory={requestHistory}
        onRead={markRead}
      />
    {/key}
    {#if typingLabel}
      <div class="typing" aria-live="polite">
        <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>{typingLabel}</span>
        <button
          type="button"
          aria-label={$i18n.t('timeline.dismissTyping')}
          onclick={() => (typingUserIds = [])}><XIcon /></button
        >
      </div>
    {/if}
    {#key resolvedRoomId}
      <RoomComposer roomId={resolvedRoomId} onSend={sendMessage} onTyping={setTyping} />
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
    <Dialog.Root bind:open={membersOpen}>
      <Dialog.Portal>
        <Dialog.Overlay class="members-backdrop" />
        <Dialog.Content class="members-dialog">
          <MembersDrawer
            members={memberLoader.members}
            loading={memberLoader.loading}
            modal
            onClose={closeMembers}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  {/if}
</section>

<style>
  .room-view {
    display: flex;
    flex: 1;
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

  .typing {
    align-items: center;
    background: var(--sable-bg-container);
    border-top: 1px solid var(--sable-surface-var-container);
    display: flex;
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0.375rem 1rem;
  }

  .typing button {
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    margin-left: auto;
    padding: 0.25rem;
  }

  .typing button:hover,
  .typing button:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .typing button :global(svg) {
    height: 1.25rem;
    width: 1.25rem;
  }

  .typing-dots {
    display: inline-flex;
    gap: 0.1875rem;
  }

  .typing-dots i {
    background: var(--sable-primary-main);
    border-radius: 50%;
    height: 0.375rem;
    width: 0.375rem;
  }

  :global(.members-backdrop) {
    background: var(--sable-overlay);
    border: 0;
    inset: 0;
    position: fixed;
    z-index: 10;
  }

  :global(.members-dialog) {
    border: 0;
    inset: 0 0 0 auto;
    max-width: min(22rem, 85%);
    padding: 0;
    position: fixed;
    width: 100%;
    z-index: 11;
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
