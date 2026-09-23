<script lang="ts">
  import type { InboxItemView } from '#src/generated/protocol';
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import AtIcon from 'phosphor-svelte/lib/AtIcon';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { formatMessageTimestamp } from '#lib/features/room/timeline-format.js';
  import { focusRowAt, formatCompactTimestamp, type NotificationFilter, senderName } from './inbox';
  import { InboxFeed } from './inbox-feed.svelte';
  import InboxFeedRow from './InboxFeedRow.svelte';
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
  const headingId = $props.id();
  const feed = new InboxFeed(core.commands);
  const marking = new SvelteSet<string>();
  const readNow = new SvelteSet<string>();
  const filters: readonly NotificationFilter[] = ['all', 'mentions', 'direct'];
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

  onMount(() => {
    void feed.backfill(false);
  });

  let rows = $derived(
    feed.items
      .map((item) => (readNow.has(item.event_id) ? { ...item, read: true } : item))
      .filter((item) => includeRead || !item.read)
  );

  function roomName(item: InboxItemView): string {
    return roomList.labelFor(item.room_id);
  }

  function sender(item: InboxItemView): string {
    return item.sender_name ?? senderName(item.sender);
  }

  function preview(item: InboxItemView): string {
    if (item.body !== null) return item.body;
    return $i18n.t(item.encrypted ? 'inbox.encryptedMessage' : 'inbox.noPreview');
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
  }

  async function loadOlder(): Promise<void> {
    if (!feed.hasMore) await feed.backfill(true);
    pageSize += PAGE_SIZE;
  }

  async function markRead(item: InboxItemView, element: HTMLElement): Promise<void> {
    if (marking.has(item.event_id)) return;
    const index = rows.findIndex((row) => row.event_id === item.event_id);
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
        focusRowAt(section, heading, includeRead ? index : Math.min(index, rows.length - 1));
      toasts.undoable($i18n.t('inbox.markedRead', { room: roomName(item) }), {
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

  {#if rows.length === 0}
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
    {:else if !feed.loaded || feed.backfilling}
      <p class="empty">{$i18n.t('inbox.checking')}</p>
    {:else}
      <p class="empty">{emptyLabel()}</p>
    {/if}
  {:else}
    <ul class="feed">
      {#each rows as item (item.event_id)}
        {@const where = item.is_direct ? null : roomName(item)}
        <InboxFeedRow
          roomId={item.room_id}
          eventId={item.event_id}
          name={roomName(item)}
          class={{ read: item.read }}
        >
          <span class="head">
            <span class="name">{sender(item)}</span>
            {#if where}<span class="where">{where}</span>{/if}
            <time
              class="when"
              datetime={new Date(item.ts).toISOString()}
              title={formatMessageTimestamp(item.ts)}>{formatCompactTimestamp(item.ts)}</time
            >
          </span>
          <span class="foot">
            <span class={['preview', { placeholder: item.body === null }]}>{preview(item)}</span>
            {#if item.highlight}
              <span class="mention" role="img" aria-label={$i18n.t('inbox.mention')}>
                <AtIcon aria-hidden="true" />
              </span>
            {/if}
          </span>
          {#snippet trailing()}
            {#if item.read}
              <span class="mark-read-spacer" aria-hidden="true"></span>
            {:else}
              <IconButton
                class="mark-read"
                variant="ghost"
                size="small"
                disabled={marking.has(item.event_id)}
                label={$i18n.t('inbox.markRead', { room: roomName(item) })}
                onclick={(event) => {
                  const element = event.currentTarget.closest('li');
                  if (element) void markRead(item, element);
                }}
              >
                <ChecksIcon />
              </IconButton>
            {/if}
          {/snippet}
        </InboxFeedRow>
      {/each}
    </ul>
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
  {/if}
</section>

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
    color: var(--bg-on-container);
  }

  .feed {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    list-style: none;
    margin: 0;
    overflow: hidden;
    padding: 0;
  }

  .head,
  .foot {
    align-items: baseline;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
  }

  .name {
    flex: 0 1 auto;
    font-weight: var(--font-weight-medium);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .where {
    color: var(--surface-var-on-container);
    flex: 0 1 auto;
    font-size: var(--font-size-small);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .where::before {
    content: '·';
    padding-right: var(--space-200);
  }

  .when {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
    padding-left: var(--space-200);
  }

  .preview {
    color: var(--surface-var-on-container);
    flex: 1;
    font-size: var(--font-size-small);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview.placeholder {
    font-style: italic;
  }

  .mention {
    color: var(--primary-main);
    display: flex;
    flex: 0 0 auto;
  }

  .mention :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .mark-read-spacer {
    flex: 0 0 auto;
    width: var(--control-height-300);
  }

  @media (pointer: coarse) {
    .mark-read-spacer {
      width: 2.75rem;
    }
  }

  :global(.read) .name {
    color: var(--surface-var-on-container);
    font-weight: var(--font-weight-normal);
  }

  :global(.read) .mention {
    color: var(--surface-var-on-container);
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
