<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import ThreadPanel from '#lib/features/room/ThreadPanel.svelte';
  import { Conversation } from '#lib/features/room/conversation.svelte.js';
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
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import { ForumThreads } from './forum-threads.svelte.js';
  import ForumHeader from './ForumHeader.svelte';
  import ForumThreadList from './ForumThreadList.svelte';

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();

  const core = useCoreClient();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const forumThreads = new ForumThreads(core);
  const memberLoader = new RoomMemberLoader();

  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  let roomName = $derived(resolvedRoom?.name ?? roomId);
  let roomAvatar = $derived(resolvedRoom?.avatar_url ?? null);
  let desktop = $derived(appLayout.matches);
  let threadRootId = $state<string | null>(null);
  let permissions = $state<RoomPermissionsView | null>(null);

  const conversation = new Conversation({
    core,
    personas,
    timeline: forumThreads.roomTimeline,
    roomId: () => resolvedRoomId,
  });

  $effect(() => {
    void forumThreads.start(resolvedRoomId);
    return () => {
      void forumThreads.stop();
    };
  });

  $effect(() => {
    void resolvedRoomId;
    memberLoader.reset();
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
    void forumThreads.paginateBackward(30);
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
    <ForumHeader {roomName} {roomAvatar} onBack={goBack} onSearch={openSearch} />
    <ForumThreadList
      threads={forumThreads.threads}
      loading={forumThreads.loading}
      canLoadMore={forumThreads.backwardPagination === 'idle'}
      onOpen={openThread}
      onLoadMore={loadMoreThreads}
    />
    <div class="forum-composer">
      <p class="forum-composer-hint">{$i18n.t('forum.newThreadHint')}</p>
      <RoomComposer
        roomId={resolvedRoomId}
        onSend={sendMessage}
        onSendAttachment={conversation.sendAttachment}
        onSendSticker={conversation.sendSticker}
        onSendGif={conversation.sendGif}
        onCreatePoll={conversation.createPoll}
        onSendLocation={conversation.sendLocation}
        onTyping={conversation.setTyping}
        {roomName}
        readOnly={permissions ? !permissions.can_post : false}
        context={conversation.context}
        onCancelContext={conversation.clearContext}
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
          />
        {/key}
      {/if}
    </DialogFrame>
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

  .forum-composer {
    flex: 0 0 auto;
    padding-bottom: var(--space-200);
  }

  .forum-composer-hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-300) var(--space-400) 0;
  }
</style>
