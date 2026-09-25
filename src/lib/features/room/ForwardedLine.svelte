<script lang="ts">
  import ShareFatIcon from 'phosphor-svelte/lib/ShareFatIcon';

  import type { ForwardedView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { roomLabel, useRoomList } from '#lib/rooms/room-list.svelte.js';

  import { formatDate } from './timeline-format';

  interface Props {
    forwarded: ForwardedView;
    roomId: string;
    onJumpToEvent?: (eventId: string) => void;
  }

  let { forwarded, roomId, onJumpToEvent }: Props = $props();
  const roomList = useRoomList();

  let sameRoom = $derived(forwarded.room_id === roomId && forwarded.event_id !== null);
  let origin = $derived(
    forwarded.room_id === null || sameRoom
      ? undefined
      : roomList.rooms.find((room) => room.room_id === forwarded.room_id)
  );
  let label = $derived.by(() => {
    if (sameRoom) return $i18n.t('timeline.forwardedFromEarlier');
    if (origin) return $i18n.t('timeline.forwardedFromRoom', { room: roomLabel(origin) });
    if (forwarded.room_id !== null) return $i18n.t('timeline.forwardedFromAnotherRoom');
    return $i18n.t('timeline.forwarded');
  });
  let date = $derived(forwarded.timestamp === null ? null : formatDate(forwarded.timestamp));
  let href = $derived(
    !sameRoom && forwarded.room_id !== null && forwarded.event_id !== null
      ? roomSectionPath(roomList.rooms, forwarded.room_id, forwarded.event_id)
      : null
  );
</script>

{#snippet copy()}
  <ShareFatIcon class="forwarded-icon" aria-hidden="true" />
  <span class="forwarded-copy">
    {label}{#if date}<span class="forwarded-date"> · {date}</span>{/if}
  </span>
{/snippet}

{#if sameRoom && forwarded.event_id}
  {@const target = forwarded.event_id}
  <button
    class="forwarded link"
    type="button"
    onclick={() => {
      onJumpToEvent?.(target);
    }}
  >
    {@render copy()}
  </button>
{:else if href}
  <a class="forwarded link" {href}>{@render copy()}</a>
{:else}
  <p class="forwarded">{@render copy()}</p>
{/if}

<style>
  .forwarded {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--surface-var-on-container);
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    line-height: 1.4;
    margin: 0;
    margin-bottom: var(--space-100);
    padding: 0;
    text-align: start;
    text-decoration: none;
  }

  .forwarded :global(.forwarded-icon) {
    flex: none;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .forwarded-copy {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link {
    cursor: pointer;
  }

  .link:is(:hover, :focus-visible) .forwarded-copy {
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
</style>
