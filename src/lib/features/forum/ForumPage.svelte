<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import ThreadPanel from '#lib/features/room/ThreadPanel.svelte';
  import { Conversation } from '#lib/features/room/conversation.svelte.js';
  import { PinnedEvents, providePinnedEvents } from '#lib/features/room/pinned-events.svelte.js';
  import RoomComposer from '#lib/features/composer/RoomComposer.svelte';
  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import {
    findRoomByPathId,
    roomPathParamFromId,
    useRoomList,
  } from '#lib/rooms/room-list.svelte.js';
  import { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';

  import { ForumThreads } from './forum-threads.svelte.js';
  import ForumHeader from './ForumHeader.svelte';
  import ForumThreadList from './ForumThreadList.svelte';

  const AUTO_FILL_ROUNDS = 10;

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();

  const core = useCoreClient();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const sidePanels = createMediaQuery(BREAKPOINTS.sidePanels);
  const forumThreads = new ForumThreads(core);
  const memberLoader = new RoomMemberLoader();
  const pinnedEvents = new PinnedEvents(core.commands);
  providePinnedEvents(pinnedEvents);

  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  let roomName = $derived(resolvedRoom?.name ?? roomId);
  let roomAvatar = $derived(resolvedRoom?.avatar_url ?? null);
  let desktop = $derived(sidePanels.matches);
  let threadRootId = $state<string | null>(null);
  let permissions = $state<RoomPermissionsView | null>(null);
  let autoFills = 0;

  const conversation = new Conversation({
    core,
    personas,
    timeline: forumThreads.roomTimeline,
    roomId: () => resolvedRoomId,
    encrypted: () => resolvedRoom?.encrypted ?? null,
  });

  $effect(() => {
    autoFills = 0;
    void forumThreads.start(resolvedRoomId);
    return () => {
      void forumThreads.stop();
    };
  });

  $effect(() => {
    if (forumThreads.threads.length > 0) return;
    if (forumThreads.loading || forumThreads.backwardPagination !== 'idle') return;
    if (autoFills >= AUTO_FILL_ROUNDS) return;
    autoFills += 1;
    forumThreads.paginateBackward(50).catch(() => {});
  });

  $effect(() => {
    void resolvedRoomId;
    memberLoader.reset();
  });

  $effect(() => {
    void pinnedEvents.load(resolvedRoomId);
  });

  $effect(() => {
    if (threadRootId === null) return;
    const activeRoomId = resolvedRoomId;
    void memberLoader.load(activeRoomId, (id) => core.commands.roomMembers(id));
  });

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    let current = true;
    core.commands
      .roomPermissions(activeRoomId)
      .then((next) => {
        if (current) permissions = next;
      })
      .catch(() => {
        if (current) permissions = null;
      });
    return () => {
      current = false;
    };
  });

  function goBack(): void {
    if (page.url.pathname.startsWith('/direct/')) {
      void goto(resolve('direct'));
      return;
    }
    if (page.url.pathname.startsWith('/space/') && page.params.spaceId) {
      void goto(
        resolve('/(app)/space/[spaceId]', { spaceId: roomPathParamFromId(page.params.spaceId) })
      );
      return;
    }
    void goto(resolve('/(app)/rooms'));
  }

  function openSearch(): void {
    const label = resolvedRoom?.canonical_alias ?? resolvedRoom?.name ?? resolvedRoomId;
    const scope = label.includes(' ') ? `"${label}"` : label;
    const target = `${resolve('/(app)/search')}?q=${encodeURIComponent(`in:${scope} `)}`;
    goto(target).catch(() => {
      window.location.assign(target);
    });
  }

  function openThread(eventId: string): void {
    threadRootId = eventId;
  }

  function closeThread(): void {
    threadRootId = null;
  }

  function loadMoreThreads(): void {
    forumThreads.paginateBackward(30).catch(() => {});
  }

  async function findJustSent(body: string, sentAfter: number): Promise<string | null> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const created = forumThreads.roomTimeline.items.find(
        (candidate) =>
          candidate.is_own &&
          candidate.event_id !== null &&
          candidate.thread_root === null &&
          candidate.thread_summary === null &&
          candidate.timestamp >= sentAfter &&
          'body' in candidate.content &&
          candidate.content.body === body
      );
      if (created?.event_id) return created.event_id;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    return null;
  }

  const sendMessage: typeof conversation.sendMessage = async (
    targetRoomId,
    body,
    formatted,
    mentions
  ) => {
    const sentAfter = Date.now();
    const result = await conversation.sendMessage(targetRoomId, body, formatted, mentions);
    if (result !== undefined) return result;
    const eventId = await findJustSent(body, sentAfter);
    if (eventId) threadRootId = eventId;
    return result;
  };
</script>

<svelte:head>
  <title>{roomName}</title>
</svelte:head>

<main class="forum-page" aria-label={$i18n.t('forum.label')}>
  <div class="forum-main">
    <ForumHeader
      roomId={resolvedRoomId}
      {roomName}
      {roomAvatar}
      onBack={goBack}
      onSearch={openSearch}
    />
    <div class="forum-content">
      <div class="forum-compose-area">
        <p class="forum-composer-hint">{$i18n.t('forum.newThreadHint')}</p>
        <RoomComposer
          roomId={resolvedRoomId}
          onSend={sendMessage}
          onSendAttachment={conversation.sendAttachment}
          onSendGallery={conversation.sendGallery}
          onSendSticker={conversation.sendSticker}
          onSendGif={conversation.sendGif}
          onCreatePoll={conversation.createPoll}
          onSendLocation={conversation.sendLocation}
          onTyping={conversation.setTyping}
          {roomName}
          readOnly={permissions ? !permissions.can_post : false}
          context={conversation.context}
          onCancelContext={conversation.clearContext}
          onToggleSilentReply={conversation.toggleSilentReply}
        />
      </div>
      <ForumThreadList
        threads={forumThreads.threads}
        loading={forumThreads.loading || forumThreads.backwardPagination === 'loading'}
        canLoadMore={forumThreads.backwardPagination === 'idle'}
        onOpen={openThread}
        onLoadMore={loadMoreThreads}
      />
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
        />
      {/key}
    {/if}
  {:else}
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
        />
      {/key}
    {/if}
  {/if}
</main>

<style>
  .forum-page {
    display: flex;
    flex: 1;
    height: 100%;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .forum-main {
    box-sizing: border-box;
    display: flex;
    flex: 1;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
  }

  .forum-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    margin: 0 auto;
    max-width: 60rem;
    min-height: 0;
    min-width: 0;
    width: 100%;
  }

  .forum-compose-area {
    flex: 0 0 auto;
    padding: var(--space-400) var(--space-400) var(--space-200);
  }

  .forum-composer-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0 0 var(--space-200);
  }
</style>
