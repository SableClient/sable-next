<script lang="ts">
  import type { BookmarkView } from '#src/generated/protocol';
  import { tick } from 'svelte';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatMessageTimestamp } from '#lib/features/room/timeline-format.js';
  import { useBookmarks } from '#lib/features/room/bookmarks.svelte.js';
  import { roomLabel, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { DisplayNames } from './display-names.svelte';
  import { filteredBookmarks, focusRowAt, formatCompactTimestamp } from './inbox';
  import InboxFeedRow from './InboxFeedRow.svelte';
  import MessagePreview from '#lib/features/room/MessagePreview.svelte';
  import InboxSectionHeader from './InboxSectionHeader.svelte';

  let { standalone = false }: { standalone?: boolean } = $props();
  const bookmarks = useBookmarks();
  const roomList = useRoomList();
  const names = new DisplayNames(useCoreClient());
  const headingId = $props.id();

  let query = $state('');
  let section = $state<HTMLElement>();
  let heading = $state<HTMLElement>();

  $effect(() => {
    void bookmarks.load();
  });

  let visible = $derived(filteredBookmarks(bookmarks.entries, query));

  function roomName(roomId: string, fallback: string | null): string {
    const room = roomList.byId(roomId);
    return room ? roomLabel(room) : (fallback ?? roomId);
  }

  async function toggle(bookmark: BookmarkView): Promise<boolean> {
    try {
      await bookmarks.toggle(bookmark.room_id, bookmark.event_id);
      return true;
    } catch (error) {
      console.warn('[sable inbox] updating the bookmark failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
      return false;
    }
  }

  async function remove(bookmark: BookmarkView, name: string, item: HTMLElement): Promise<void> {
    const index = visible.indexOf(bookmark);
    const hadFocus = item.contains(document.activeElement);
    if (!(await toggle(bookmark))) return;
    await tick();
    if (hadFocus) focusRowAt(section, heading, index);
    toasts.undoable($i18n.t('inbox.bookmarkRemoved', { room: name }), {
      label: $i18n.t('inbox.undo'),
      onUndo: () => {
        void toggle(bookmark).then((restored) => {
          if (restored) void bookmarks.load();
        });
      },
    });
  }
</script>

<section aria-labelledby={headingId} bind:this={section}>
  <InboxSectionHeader
    id={headingId}
    title={$i18n.t('inbox.bookmarks')}
    hidden={standalone}
    bind:heading
  />

  {#if bookmarks.entries.length > 1}
    <label
      class="search"
      {@attach (node) => {
        if (standalone) node.querySelector('input')?.focus();
      }}
    >
      <MagnifyingGlassIcon aria-hidden="true" />
      <span class="screen-reader-only">{$i18n.t('inbox.bookmarksSearchLabel')}</span>
      <TextInput
        type="search"
        bind:value={query}
        placeholder={$i18n.t('inbox.bookmarksSearchPlaceholder')}
      />
    </label>
  {/if}

  {#if bookmarks.entries.length === 0}
    <p class="empty">{$i18n.t('inbox.bookmarksEmpty')}</p>
  {:else if visible.length === 0}
    <p class="empty">{$i18n.t('inbox.bookmarksNoResults', { query })}</p>
  {:else}
    <ul class="feed">
      {#each visible as bookmark (bookmark.bookmark_id)}
        {@const name = roomName(bookmark.room_id, bookmark.room_name)}
        {@const from = bookmark.sender ? names.name(bookmark.sender) : null}
        <InboxFeedRow roomId={bookmark.room_id} eventId={bookmark.event_id} {name}>
          <span class="head">
            <span class="name">{name}</span>
            <time
              class="when"
              datetime={new Date(bookmark.bookmarked_ts).toISOString()}
              title={formatMessageTimestamp(bookmark.bookmarked_ts)}
              >{formatCompactTimestamp(bookmark.bookmarked_ts)}</time
            >
          </span>
          {#snippet message()}
            <MessagePreview roomId={bookmark.room_id} eventId={bookmark.event_id}>
              {#snippet fallback()}
                <span class="preview">
                  {#if from}<span class="sender">{from}:</span>&nbsp;{/if}{bookmark.body_preview ??
                    $i18n.t('inbox.bookmarkPreviewEmpty')}
                </span>
              {/snippet}
            </MessagePreview>
          {/snippet}
          {#snippet trailing()}
            <IconButton
              class="remove"
              variant="ghost"
              size="small"
              label={$i18n.t('inbox.removeBookmark', { room: name })}
              onclick={(event) => {
                const item = event.currentTarget.closest('li');
                if (item) void remove(bookmark, name, item);
              }}
            >
              <XIcon />
            </IconButton>
          {/snippet}
        </InboxFeedRow>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .search {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    margin-bottom: var(--space-300);
  }

  .search :global(svg) {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
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

  .head {
    align-items: baseline;
    display: flex;
    gap: var(--space-300);
    min-width: 0;
  }

  .name {
    flex: 1;
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .preview {
    color: var(--surface-var-on-container);
    display: block;
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sender {
    font-weight: var(--font-weight-medium);
  }

  .empty {
    color: var(--surface-var-on-container);
    margin: 0;
    text-align: center;
  }
</style>
