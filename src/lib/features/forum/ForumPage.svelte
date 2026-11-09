<script lang="ts">
  import { untrack } from 'svelte';
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { RoomPermissionsView } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import { personaSpaces } from '#lib/features/composer/persona-spaces.js';
  import { eventTimelinePath } from '#lib/features/room/event-timeline.js';
  import ConversationComposer from '#lib/features/room/conversation/ConversationComposer.svelte';
  import ThreadView from '#lib/features/room/conversation/ThreadView.svelte';
  import { Conversation } from '#lib/features/room/conversation/conversation.svelte.js';
  import { donateSentMessage } from '#lib/features/share/donate-sent-message.js';
  import {
    PinnedEvents,
    pinErrorMessage,
    providePinnedEvents,
  } from '#lib/features/room/timeline/pinned-events.svelte.js';
  import {
    backToRoomList,
    searchInRoom,
    trackRoomEntry,
  } from '#lib/features/room/room-navigation.js';
  import TimelineReadReceipt from '#lib/features/room/timeline/TimelineReadReceipt.svelte';
  import MessageContextMenu from '#lib/features/room/messages/MessageContextMenu.svelte';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import RoomBannerStrip from '#lib/features/room/RoomBannerStrip.svelte';
  import { copyRoomLink } from '#lib/rooms/permalink.js';
  import { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { ForumThreads } from './forum-threads.svelte.js';
  import ForumHeader from './ForumHeader.svelte';
  import ForumThreadList from './ForumThreadList.svelte';

  const AUTO_FILL_ROUNDS = 10;
  const FORUM_TITLE_MAX = 150;

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();

  const core = useCoreClient();
  trackRoomEntry();
  const personas = usePersonaStore();
  const roomList = useRoomList();
  const messageMenu = provideMessageMenu(new OpenMessageMenu());
  const forumThreads = new ForumThreads(core);
  const memberLoader = new RoomMemberLoader();
  const pinnedEvents = new PinnedEvents(core.rpc.timeline);
  providePinnedEvents(pinnedEvents);

  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  let roomName = $derived(resolvedRoom?.name ?? roomId);
  let roomAvatar = $derived(resolvedRoom?.avatar_url ?? null);
  let threadRootId = $derived.by<string | null>(() => {
    void resolvedRoomId;
    return null;
  });
  const sidePanels = new MediaQuery(BREAKPOINTS.sidePanels);
  let threadInPanel = $derived(sidePanels.current && preferences.threadPresentation === 'panel');
  let permissions = $state.raw<RoomPermissionsView | null>(null);
  let latestEventId = $derived.by(() => {
    const items = forumThreads.roomTimeline.items;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const eventId = items[index]?.event_id;
      if (eventId != null) return eventId;
    }
    return null;
  });
  let autoFills = 0;

  const conversation = new Conversation({
    core,
    personas,
    timeline: forumThreads.roomTimeline,
    roomId: () => resolvedRoomId,
    spaceIds: (id) => personaSpaces(roomList.rooms, id, page.params.spaceId).order,
    encrypted: () => resolvedRoom?.encrypted ?? null,
    afterSend: (id) => donateSentMessage(core, roomList.byId(id)),
  });

  $effect(() => {
    autoFills = 0;
    const id = resolvedRoomId;
    void untrack(() => forumThreads.start(id));
    return () => {
      void forumThreads.stop();
    };
  });

  $effect(() => {
    if (forumThreads.error || forumThreads.threads.length > 0) return;
    if (forumThreads.loading || forumThreads.backwardPagination !== 'idle') return;
    if (autoFills >= AUTO_FILL_ROUNDS) return;
    autoFills += 1;
    forumThreads.paginateBackward(50).catch((error: unknown) => {
      console.warn('[sable forum] loading threads failed', error);
    });
  });

  $effect(() => {
    void resolvedRoomId;
    memberLoader.reset();
  });

  $effect(() => {
    void pinnedEvents.load(resolvedRoomId);
  });

  let wasEditing = false;
  $effect(() => {
    const editing = conversation.context?.kind === 'edit';
    if (wasEditing && !editing) conversation.forumTitle = '';
    wasEditing = editing;
  });

  $effect(() => {
    if (threadRootId === null) return;
    const activeRoomId = resolvedRoomId;
    void memberLoader.load(activeRoomId, (id) =>
      core.rpc.members.list({ room_id: id, memberships: [] })
    );
  });

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    let current = true;
    core.rpc.members
      .permissions({ room_id: activeRoomId })
      .then((next) => {
        if (current) permissions = next;
      })
      .catch((error: unknown) => {
        console.warn('[sable forum] loading permissions failed', error);
        if (current) permissions = null;
      });
    return () => {
      current = false;
    };
  });

  async function markRead(eventId: string): Promise<void> {
    await core.rpc.timeline.markRead({
      room_id: resolvedRoomId,
      event_id: eventId,
      thread_root: null,
      subscription: forumThreads.roomTimeline.subscriptionId,
      fully_read: false,
    });
  }

  function openThread(eventId: string): void {
    threadRootId = eventId;
  }

  function editThread(thread: (typeof forumThreads.threads)[number]): void {
    conversation.edit(thread.eventId, thread.preview, thread.html, thread.mediaCaption);
  }

  function deleteThread(eventId: string, reason: string | null): void {
    void core.rpc.messages
      .deleteThread({ room_id: resolvedRoomId, root_event_id: eventId, reason })
      .catch((error: unknown) => {
        console.warn('[sable forum] deleting a thread failed', error);
        toasts.error(i18n.t('errors.actionFailed'));
      });
  }

  function togglePin(eventId: string): void {
    pinnedEvents.toggle(resolvedRoomId, eventId).catch((error: unknown) => {
      console.warn('[sable forum] pinning a thread failed', error);
      toasts.error(pinErrorMessage(error));
    });
  }

  function copyEventLink(eventId: string): void {
    void copyRoomLink(
      core,
      { room_id: resolvedRoomId, canonical_alias: resolvedRoom?.canonical_alias ?? null },
      eventId
    ).then((copied) => {
      if (!copied) toasts.error(i18n.t('errors.copyFailed'));
      else toasts.info(i18n.t('timeline.linkCopied'));
    });
  }

  function canDeleteThread(thread: (typeof forumThreads.threads)[number]): boolean {
    return (
      (permissions?.can_redact_others ?? false) ||
      (thread.replyCount === 0 && thread.isOwn && (permissions?.can_redact_own ?? true))
    );
  }

  holdOverlayBack(() => threadRootId !== null, closeThread);

  function closeThread(): void {
    threadRootId = null;
  }

  function loadMoreThreads(): void {
    forumThreads.paginateBackward(30).catch((error: unknown) => {
      console.warn('[sable forum] loading threads failed', error);
    });
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

<PageTitle title={roomName} />

<TimelineReadReceipt
  timeline={forumThreads.roomTimeline}
  visibleEventId={latestEventId}
  onRead={markRead}
  enabled={threadRootId === null || threadInPanel}
/>
<MessageContextMenu menu={messageMenu} />

<main class="forum-page" aria-label={i18n.t('forum.label')} data-inset-owner="top">
  <div
    class={['forum-main', { 'thread-covered': threadRootId !== null && !threadInPanel }]}
    inert={threadRootId !== null && !threadInPanel}
  >
    <ForumHeader
      roomId={resolvedRoomId}
      {roomName}
      {roomAvatar}
      onBack={backToRoomList}
      onSearch={() => searchInRoom(resolvedRoom, resolvedRoomId)}
      onEventTimeline={preferences.developerTools
        ? () => {
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- eventTimelinePath() resolves the route itself
            void goto(eventTimelinePath(resolvedRoomId));
          }
        : undefined}
    />
    <RoomBannerStrip roomId={resolvedRoomId} />
    <div class="forum-content">
      <div class="forum-compose-area">
        <p class="forum-composer-hint">{i18n.t('forum.newThreadHint')}</p>
        <TextInput
          bind:value={conversation.forumTitle}
          maxlength={FORUM_TITLE_MAX}
          placeholder={i18n.t('forum.titlePlaceholder')}
          aria-label={i18n.t('forum.titleLabel')}
          disabled={permissions ? !permissions.can_post : false}
        />
        <ConversationComposer
          {conversation}
          roomId={resolvedRoomId}
          onSend={sendMessage}
          {roomName}
          readOnly={permissions ? !permissions.can_post : false}
        />
      </div>
      <ForumThreadList
        threads={forumThreads.threads}
        failed={forumThreads.error}
        onRetry={() => void forumThreads.retry()}
        loading={forumThreads.loading || forumThreads.backwardPagination === 'loading'}
        canLoadMore={forumThreads.canLoadMore}
        onOpen={openThread}
        canDelete={canDeleteThread}
        onEdit={permissions?.can_post === false ? undefined : editThread}
        onDelete={deleteThread}
        roomId={resolvedRoomId}
        onReact={permissions?.can_react === false ? undefined : conversation.toggleReaction}
        onCopyLink={copyEventLink}
        onLoadMore={loadMoreThreads}
        isPinned={(eventId) => pinnedEvents.has(eventId)}
        onPin={permissions?.can_pin ? togglePin : undefined}
      />
    </div>
  </div>

  {#if threadRootId !== null}
    {#key `${resolvedRoomId}:${threadRootId}`}
      <ThreadView
        roomId={resolvedRoomId}
        rootEventId={threadRootId}
        sidePanel={threadInPanel}
        backLabel={i18n.t('forum.backToForum')}
        rootMessage={forumThreads.roomTimeline.items.find((item) => item.event_id === threadRootId)}
        {roomName}
        members={memberLoader.members}
        readOnly={permissions ? !permissions.can_post : false}
        canRedactOwn={permissions?.can_redact_own ?? true}
        canRedactOthers={permissions?.can_redact_others ?? false}
        canReact={permissions?.can_react ?? true}
        canPin={permissions?.can_pin ?? false}
        encrypted={resolvedRoom?.encrypted ?? null}
        onCopyLink={copyEventLink}
        onClose={closeThread}
      />
    {/key}
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

  .thread-covered {
    inset: 0;
    pointer-events: none;
    position: absolute;
    visibility: hidden;
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

  .forum-compose-area :global(.text-input) {
    margin-bottom: var(--space-200);
  }

  .forum-composer-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0 0 var(--space-200);
  }
</style>
