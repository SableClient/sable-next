<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import type { MemberView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { InboxFeed } from '#lib/features/inbox/inbox-feed.svelte.js';
  import { senderName } from '#lib/features/inbox/inbox.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  import MessagePreview from './messages/MessagePreview.svelte';
  import RoomSidePanel from './RoomSidePanel.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onJump: (eventId: string) => void;
    onClose: () => void;
  }

  const PAGE_SIZE = 30;
  const filters = [
    { value: 'mentions', label: 'inbox.filterMentions' },
    { value: 'all', label: 'inbox.filterAll' },
  ] as const;

  let { roomId, members, modal = false, onJump, onClose }: Props = $props();
  const core = useCoreClient();
  const feed = untrack(() => new InboxFeed(core.rpc.notifications, roomId));
  onDestroy(() => feed.dispose());

  let filter = $state<'mentions' | 'all'>('mentions');
  let size = $state(PAGE_SIZE);
  let query = $state('');

  function reload(): Promise<void> {
    return feed.load(filter, true, size, query.trim());
  }

  $effect(() => {
    void reload();
  });

  $effect(() =>
    core.subscribeEvents((event) => {
      if (event.type === 'inbox_changed') void reload();
    })
  );

  $effect(() => {
    void feed.backfill(true).then(reload);
  });

  async function loadOlder(): Promise<void> {
    if (!feed.hasMore) await feed.backfill(true);
    size += PAGE_SIZE;
  }
</script>

<RoomSidePanel
  title={i18n.t('inbox.notifications')}
  closeLabel={i18n.t('room.notificationsClose')}
  resizeLabel={i18n.t('room.notificationsResize')}
  widthKey="sable-room-notifications-width"
  width={22}
  body="none"
  {modal}
  {onClose}
>
  {#snippet icon()}
    <BellIcon aria-hidden="true" />
  {/snippet}
  <div class="controls">
    <div class="filters" role="group" aria-label={i18n.t('inbox.filterLabel')}>
      {#each filters as option (option.value)}
        <Button
          variant="ghost"
          size="small"
          class="choice"
          aria-pressed={option.value === filter}
          onclick={() => (filter = option.value)}
        >
          {i18n.t(option.label)}
        </Button>
      {/each}
    </div>
    <TextInput
      type="search"
      bind:value={query}
      placeholder={i18n.t('room.notificationsSearch')}
      aria-label={i18n.t('room.notificationsSearch')}
    />
  </div>

  <div class="list" {@attach scrollHint}>
    {#if feed.failed}
      <p class="status" role="alert">{i18n.t('inbox.loadFailed')}</p>
    {:else if feed.items.length === 0}
      <p class="status">
        {#if !feed.loaded || !feed.checked}
          {i18n.t('inbox.checking')}
        {:else if query.trim() !== ''}
          {i18n.t('room.notificationsNoResults', { query: query.trim() })}
        {:else}
          {i18n.t('room.notificationsEmpty')}
        {/if}
      </p>
    {:else}
      <ul>
        {#each feed.items as item, index (item.event_id)}
          <li>
            {#if item.thread_root}
              <p class="thread-label">{i18n.t('inbox.inThread')}</p>
            {/if}
            <MessagePreview
              timeline
              {roomId}
              eventId={item.event_id}
              previousEventId={feed.items[index - 1]?.event_id}
              {members}
              loadPreviewProfile
              onJumpToEvent={onJump}
              onOpenMedia={onJump}
              timeAction={{ label: i18n.t('inbox.openMessage'), run: () => onJump(item.event_id) }}
            >
              {#snippet fallback()}
                <p class="preview">
                  <strong>{item.sender_name ?? senderName(item.sender)}</strong>
                  {item.body ??
                    i18n.t(item.encrypted ? 'inbox.encryptedMessage' : 'inbox.noPreview')}
                </p>
              {/snippet}
            </MessagePreview>
          </li>
        {/each}
      </ul>
    {/if}
    {#if !feed.failed}
      <div class="more">
        <Button
          variant="ghost"
          size="small"
          disabled={feed.backfilling}
          onclick={() => void loadOlder()}
        >
          {i18n.t(feed.backfilling ? 'inbox.checking' : 'inbox.loadOlder')}
        </Button>
      </div>
    {/if}
  </div>
</RoomSidePanel>

<style>
  .controls {
    border-bottom: var(--border-width) solid var(--bg-container-line);
    display: grid;
    flex: none;
    gap: var(--space-200);
    padding: var(--space-300);
  }

  .filters {
    display: flex;
    gap: var(--space-200);
  }

  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .status,
  .thread-label {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .status {
    padding: var(--space-300);
  }

  .thread-label {
    padding: var(--space-200) var(--page-gutter) 0;
  }

  .preview {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .more {
    display: flex;
    justify-content: center;
    padding: var(--space-300);
  }
</style>
