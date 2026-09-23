<script lang="ts">
  import type { BookmarkView } from '#src/generated/protocol';
  import { tick } from 'svelte';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatMessageTimestamp } from '#lib/features/room/timeline-format.js';
  import { useBookmarks } from '#lib/features/room/bookmarks.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { DisplayNames } from './display-names.svelte';
  import { filteredBookmarks, formatCompactTimestamp } from './inbox';

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
    return roomList.rooms.find((room) => room.room_id === roomId)?.name ?? fallback ?? roomId;
  }

  function roomAvatarUrl(roomId: string): string | null {
    return roomList.rooms.find((room) => room.room_id === roomId)?.avatar_url ?? null;
  }

  function focusRowAt(index: number): void {
    const rows = section?.querySelectorAll<HTMLElement>('a.row') ?? [];
    const target = rows[Math.min(index, rows.length - 1)] ?? heading;
    target?.focus();
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
    if (hadFocus) focusRowAt(index);
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
  <div class="header">
    <h2 id={headingId} class={{ 'visually-hidden': standalone }} tabindex="-1" bind:this={heading}>
      {$i18n.t('inbox.bookmarks')}
    </h2>
  </div>

  {#if bookmarks.entries.length > 1}
    <label
      class="search"
      {@attach (node) => {
        if (standalone) node.querySelector('input')?.focus();
      }}
    >
      <MagnifyingGlassIcon aria-hidden="true" />
      <span class="visually-hidden">{$i18n.t('inbox.bookmarksSearchLabel')}</span>
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
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath resolves the route itself -->
          <a
            class="row"
            href={roomSectionPath(roomList.rooms, bookmark.room_id, bookmark.event_id)}
          >
            <Avatar id={bookmark.room_id} src={roomAvatarUrl(bookmark.room_id)} {name} />
            <span class="body">
              <span class="head">
                <span class="name">{name}</span>
                <time
                  class="when"
                  datetime={new Date(bookmark.bookmarked_ts).toISOString()}
                  title={formatMessageTimestamp(bookmark.bookmarked_ts)}
                  >{formatCompactTimestamp(bookmark.bookmarked_ts)}</time
                >
              </span>
              <span class="preview">
                {#if from}<span class="sender">{from}:</span>&nbsp;{/if}{bookmark.body_preview ??
                  $i18n.t('inbox.bookmarkPreviewEmpty')}
              </span>
            </span>
          </a>
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
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .header {
    align-items: baseline;
    display: flex;
    justify-content: space-between;
    margin-bottom: var(--space-300);
  }

  h2 {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  h2:focus {
    outline: none;
  }

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

  .visually-hidden {
    block-size: 1px;
    clip-path: inset(50%);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
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

  li {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    padding-right: var(--space-300);
  }

  li + li {
    border-top: var(--border-width) solid var(--bg-container-line);
  }

  @media (hover: hover) and (pointer: fine) {
    li:hover {
      background: var(--bg-container-hover);
    }
  }

  .row {
    align-items: center;
    color: inherit;
    display: flex;
    flex: 1;
    gap: var(--space-300);
    min-width: 0;
    padding: var(--space-300) var(--space-400);
    text-decoration: none;
  }

  .row:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .body {
    display: grid;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
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

  @media (prefers-reduced-motion: no-preference) {
    .row {
      transition: background var(--motion-fast) var(--motion-easing-standard);
    }
  }

  @media (pointer: coarse) {
    li :global(.icon-button) {
      min-height: 2.75rem;
      min-width: 2.75rem;
    }
  }
</style>
