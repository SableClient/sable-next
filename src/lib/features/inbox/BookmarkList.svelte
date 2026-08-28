<script lang="ts">
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatDate, formatTime } from '#lib/features/room/timeline-format.js';
  import { useBookmarks } from '#lib/features/room/bookmarks.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { filteredBookmarks, senderName } from './inbox';

  const bookmarks = useBookmarks();
  const roomList = useRoomList();
  const headingId = $props.id();

  let query = $state('');

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

  function when(timestamp: number): string {
    const sameDay = new Date(timestamp).toDateString() === new Date().toDateString();
    return sameDay ? formatTime(timestamp) : formatDate(timestamp);
  }

  function remove(roomId: string, eventId: string): void {
    void bookmarks.toggle(roomId, eventId);
  }
</script>

<section aria-labelledby={headingId}>
  <div class="header">
    <h2 id={headingId}>{$i18n.t('inbox.bookmarks')}</h2>
  </div>

  {#if bookmarks.entries.length > 0}
    <label class="search">
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
        {@const from = bookmark.sender ? senderName(bookmark.sender) : null}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath resolves the route itself -->
          <a
            class="row"
            href={roomSectionPath(roomList.rooms, bookmark.room_id, bookmark.event_id)}
          >
            <Avatar src={roomAvatarUrl(bookmark.room_id)} {name} />
            <span class="body">
              <span class="head">
                <span class="name">{name}</span>
                <span class="when">{when(bookmark.bookmarked_ts)}</span>
              </span>
              <span class="preview">
                {#if from}<span class="sender">{from}: </span>{/if}{bookmark.body_preview ??
                  $i18n.t('inbox.bookmarkPreviewEmpty')}
              </span>
            </span>
          </a>
          <IconButton
            class="remove"
            variant="ghost"
            size="small"
            label={$i18n.t('inbox.removeBookmark', { room: name })}
            onclick={() => {
              remove(bookmark.room_id, bookmark.event_id);
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
    margin-bottom: var(--space-2);
  }

  h2 {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  .search {
    align-items: center;
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .search :global(svg) {
    color: var(--sable-surface-var-on-container);
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
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    list-style: none;
    margin: 0;
    overflow: hidden;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    gap: var(--space-1);
    padding-right: var(--space-2);
  }

  li + li {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
  }

  li:hover {
    background: var(--sable-bg-container-hover);
  }

  .row {
    align-items: center;
    color: inherit;
    display: flex;
    flex: 1;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    text-decoration: none;
  }

  .row:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .body {
    display: grid;
    flex: 1;
    gap: var(--space-compact);
    min-width: 0;
  }

  .head {
    align-items: baseline;
    display: flex;
    gap: var(--space-2);
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
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .preview {
    color: var(--sable-surface-var-on-container);
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
    color: var(--sable-surface-var-on-container);
    margin: 0;
    text-align: center;
  }

  @media (prefers-reduced-motion: no-preference) {
    .row {
      transition: background var(--motion-fast) var(--motion-easing-standard);
    }
  }
</style>
