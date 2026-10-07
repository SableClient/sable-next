<script lang="ts">
  import type { InboxItemView, PerMessageProfileView } from '#src/generated/protocol';
  import { goto } from '$app/navigation';
  import { onDestroy, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import AtIcon from 'phosphor-svelte/lib/AtIcon';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import {
    backfillSignal,
    focusRowAt,
    groupNotifications,
    senderName,
    type NotificationFilter,
  } from './inbox';
  import { InboxFeed } from './inbox-feed.svelte';
  import InboxFeedRow from './InboxFeedRow.svelte';
  import MessagePreview from '#lib/features/room/messages/MessagePreview.svelte';
  import MentionProfile from '#lib/features/room/members/MentionProfile.svelte';
  import { MemberProfile } from '#lib/features/room/members/member-profile.svelte.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { splitVia } from '#lib/rooms/join-address.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import InboxSectionHeader from './InboxSectionHeader.svelte';
  import { markRoomUnread } from '#lib/features/sidebar/nav-rooms.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  interface Props {
    filter: NotificationFilter;
    onFilter: (filter: NotificationFilter) => void;
    limit?: number;
  }

  const PAGE_SIZE = 30;

  let { filter, onFilter, limit }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const memberProfile = new MemberProfile(core);
  let profileRoomId = $state('');
  const headingId = $props.id();
  const feed = new InboxFeed(core.commands);
  onDestroy(() => {
    feed.dispose();
    memberProfile.close();
  });
  const marking = new SvelteSet<string>();
  const readNow = new SvelteSet<string>();
  const filters: readonly NotificationFilter[] = ['direct', 'mentions', 'all'];
  const filterLabels: Record<NotificationFilter, string> = {
    all: 'inbox.filterAll',
    mentions: 'inbox.filterMentions',
    direct: 'inbox.filterDirect',
  };
  const emptyLabels: Record<NotificationFilter, string> = {
    all: 'inbox.notificationsEmptyAll',
    mentions: 'inbox.notificationsEmptyMentions',
    direct: 'inbox.notificationsEmptyDirect',
  };
  let section = $state<HTMLElement>();
  let heading = $state<HTMLElement>();
  let announcement = $state('');
  let includeRead = $state(false);
  let pageSize = $state(PAGE_SIZE);
  let size = $derived(limit ?? pageSize);
  let compact = $derived(limit !== undefined);

  $effect(() => {
    void roomList.rooms;
    void feed.load(filter, includeRead, size);
  });

  $effect(() =>
    core.subscribeEvents((event) => {
      if (event.type === 'inbox_changed') void feed.load(filter, includeRead, size);
    })
  );

  let waiting = $derived(backfillSignal(roomList.rooms));

  $effect(() => {
    void waiting;
    void feed.backfill(false).then(() => feed.load(filter, includeRead, size));
  });

  let rows = $derived(
    feed.items
      .map((item) => (readNow.has(item.event_id) ? { ...item, read: true } : item))
      .filter((item) => includeRead || !item.read)
  );

  let groups = $derived(groupNotifications(rows).slice(0, size));

  function openMessage(roomId: string, eventId: string): void {
    void afterOverlayPops().then(() => goto(roomSectionPath(roomList.rooms, roomId, eventId)));
  }

  function openProfile(
    roomId: string,
    userId: string,
    anchor: HTMLElement,
    pmp?: PerMessageProfileView | null
  ): void {
    profileRoomId = roomId;
    if (pmp) memberProfile.showPmp(userId, anchor, pmp);
    else void memberProfile.show(userId, anchor);
  }

  function handleMatrixLink(roomId: string, link: MatrixLink, anchor: HTMLAnchorElement): void {
    if (link.kind === 'user') openProfile(roomId, link.userId, anchor);
    else {
      const path = roomSectionPath(
        roomList.rooms,
        link.roomId,
        link.kind === 'event' ? link.eventId : null,
        splitVia(anchor.href).via
      );
      void afterOverlayPops().then(() => goto(path));
    }
  }

  function emptyLabel(): string {
    return $i18n.t(includeRead ? 'inbox.notificationsEmptyHistory' : emptyLabels[filter]);
  }

  async function selectFilter(value: NotificationFilter): Promise<void> {
    onFilter(value);
    await tick();
    await feed.load(value, includeRead, size);
    announcement =
      rows.length === 0 ? emptyLabel() : $i18n.t('inbox.filterResults', { count: rows.length });
  }

  function toggleRead(): void {
    includeRead = !includeRead;
    pageSize = PAGE_SIZE;
    if (includeRead) void feed.backfill(true).then(() => feed.load(filter, includeRead, size));
  }

  async function loadOlder(): Promise<void> {
    if (!feed.hasMore) await feed.backfill(true);
    pageSize += PAGE_SIZE;
  }

  async function markRead(item: InboxItemView, element: HTMLElement): Promise<void> {
    if (marking.has(item.event_id)) return;
    const index = groups.findIndex((group) => group.roomId === item.room_id);
    const hadFocus = element.contains(document.activeElement);
    const covered = feed.items.filter(
      (candidate) => candidate.room_id === item.room_id && candidate.ts <= item.ts
    );
    marking.add(item.event_id);
    try {
      await core.commands.markRead(item.room_id, item.event_id, readReceiptIsPrivate());
      for (const candidate of covered) readNow.add(candidate.event_id);
      await tick();
      if (hadFocus)
        focusRowAt(section, heading, includeRead ? index : Math.min(index, groups.length - 1));
      toasts.undoable($i18n.t('inbox.markedRead', { room: roomList.labelFor(item.room_id) }), {
        label: $i18n.t('inbox.undo'),
        onUndo: () => {
          for (const candidate of covered) readNow.delete(candidate.event_id);
          markRoomUnread(item.room_id, core.commands);
        },
      });
    } catch (error) {
      console.warn('[sable inbox] marking the room read failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    } finally {
      marking.delete(item.event_id);
    }
  }
</script>

<section aria-labelledby={headingId} aria-busy={feed.backfilling} bind:this={section}>
  <InboxSectionHeader id={headingId} title={$i18n.t('inbox.notifications')} bind:heading>
    <div class="filters" role="group" aria-label={$i18n.t('inbox.filterLabel')}>
      {#each filters as value (value)}
        <Button
          variant="ghost"
          size="small"
          class="filter choice"
          aria-pressed={value === filter}
          onclick={() => {
            void selectFilter(value);
          }}
        >
          {$i18n.t(filterLabels[value])}
        </Button>
      {/each}
      {#if !compact}
        <Button
          variant="ghost"
          size="small"
          class="filter choice"
          aria-pressed={includeRead}
          onclick={toggleRead}
        >
          {$i18n.t('inbox.showRead')}
        </Button>
      {/if}
    </div>
  </InboxSectionHeader>

  <p class="screen-reader-only" role="status">{announcement}</p>

  {#if feed.failed}
    <div class="notice">
      <p>{$i18n.t('inbox.loadFailed')}</p>
      <Button
        variant="secondary"
        size="small"
        onclick={() => {
          void feed.backfill(includeRead).then(() => feed.load(filter, includeRead, size));
        }}>{$i18n.t('inbox.retry')}</Button
      >
    </div>
  {/if}
  {#if rows.length === 0}
    {#if !feed.failed}
      {#if !feed.loaded || !feed.checked || feed.backfilling}
        <p class="empty">{$i18n.t('inbox.checking')}</p>
      {:else}
        <p class="empty">{emptyLabel()}</p>
      {/if}
    {/if}
  {:else}
    <ul class="feed">
      {#each groups as group (group.roomId)}
        {@const name = roomList.labelFor(group.roomId)}
        <InboxFeedRow
          compact
          roomId={group.roomId}
          eventId={group.latest.event_id}
          {name}
          class={{ read: group.read }}
        >
          <span class="head">
            <span class="name">{name}</span>
            {#if group.highlight}<AtIcon aria-label={$i18n.t('inbox.mention')} />{/if}
          </span>
          {#snippet message()}
            {#each group.items as item, index (item.event_id)}
              <MessagePreview
                timeline
                roomId={group.roomId}
                eventId={item.event_id}
                previousEventId={group.items[index - 1]?.event_id}
                loadPreviewProfile
                onSenderProfile={(userId, anchor, pmp) =>
                  openProfile(group.roomId, userId, anchor, pmp)}
                onMatrixLink={(link, anchor) => handleMatrixLink(group.roomId, link, anchor)}
                onJumpToEvent={(eventId) => openMessage(group.roomId, eventId)}
                onOpenMedia={(eventId) => openMessage(group.roomId, eventId)}
                timeAction={{
                  label: $i18n.t('inbox.openMessage'),
                  run: () => openMessage(group.roomId, item.event_id),
                }}
              >
                {#snippet fallback()}
                  <p class="preview">
                    <strong>{item.sender_name ?? senderName(item.sender)}</strong>
                    {item.body ??
                      $i18n.t(item.encrypted ? 'inbox.encryptedMessage' : 'inbox.noPreview')}
                  </p>
                {/snippet}
              </MessagePreview>
            {/each}
            {#if group.hasMore}
              <Button
                variant="ghost"
                size="small"
                onclick={() => openMessage(group.roomId, group.firstEventId)}
              >
                {$i18n.t('inbox.moreNotifications')}
              </Button>
            {/if}
          {/snippet}
          {#snippet trailing()}
            {#if !group.read}
              <IconButton
                variant="ghost"
                size="small"
                disabled={marking.has(group.latest.event_id)}
                label={$i18n.t('inbox.markRead', { room: name })}
                onclick={(event) => {
                  const element = event.currentTarget.closest('li');
                  if (element) void markRead(group.latest, element);
                }}><ChecksIcon /></IconButton
              >
            {/if}
          {/snippet}
        </InboxFeedRow>
      {/each}
    </ul>
  {/if}
  {#if !compact && (feed.hasMore || includeRead)}
    <Button
      class="load-older"
      variant="ghost"
      size="small"
      disabled={feed.backfilling}
      onclick={() => {
        void loadOlder();
      }}
    >
      {$i18n.t(feed.backfilling ? 'inbox.checking' : 'inbox.loadOlder')}
    </Button>
  {/if}
</section>

<MentionProfile
  bind:open={memberProfile.open}
  userId={memberProfile.userId}
  anchor={memberProfile.anchor}
  roomId={profileRoomId}
  member={null}
  profile={memberProfile.profile}
  pmp={memberProfile.pmp}
  failed={memberProfile.failed}
  onMatrixLink={(link, anchor) => handleMatrixLink(profileRoomId, link, anchor)}
/>

<style>
  section {
    display: grid;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  :global(.filter) {
    background: transparent;
    border-color: transparent;
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    padding: 0 var(--space-300);
  }

  :global(.filter:hover:not(:disabled)) {
    background: var(--surface-var-container-hover);
    color: var(--surface-var-on-container);
  }

  .feed {
    background: var(--bg-container);
    border-block: var(--border-width) solid var(--bg-container-line);
    color: var(--bg-on-container);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .head {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
  }

  .name {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head :global(svg) {
    color: var(--primary-main);
    flex-shrink: 0;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.read) .name {
    color: var(--surface-var-on-container);
    font-weight: var(--font-weight-normal);
  }

  .preview {
    font-size: var(--font-size-editor);
    margin: var(--space-100) 0;
  }

  .empty {
    color: var(--surface-var-on-container);
    margin: 0;
    text-align: center;
  }

  .notice {
    color: var(--surface-var-on-container);
    display: grid;
    gap: var(--space-200);
    place-items: center;
  }

  .notice p {
    margin: 0;
  }

  :global(.load-older) {
    justify-self: center;
    margin-top: var(--space-300);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.filter) {
      transition: background var(--motion-fast) var(--motion-easing-standard);
    }
  }

  @media (pointer: coarse) {
    :global(.filter) {
      min-height: 2.75rem;
    }
  }
</style>
