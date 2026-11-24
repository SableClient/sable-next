<script module lang="ts">
  import type { PreviewEmote } from '#src/generated/protocol';

  export interface RoomPreview {
    sender: string | null;
    text: string;
    emotes: readonly PreviewEmote[];
  }
</script>

<script lang="ts">
  import type { RoomListItemView, StatusView } from '#src/generated/protocol';
  import PreviewSegments from '#lib/features/room/messages/PreviewSegments.svelte';
  import { previewSegments } from '#lib/features/room/messages/reply-preview.js';
  import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import CalendarRowEvent from '#lib/features/calendar/CalendarRowEvent.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { i18n } from '#lib/i18n.js';

  interface Props {
    name: string;
    room?: RoomListItemView;
    preview?: RoomPreview | null;
    peerStatus?: StatusView | null;
  }

  let { name, room, preview = null, peerStatus = null }: Props = $props();

  let emotesShown = $derived(mediaPreviewSettings.shownIn(room));
</script>

<span class="room-text">
  <span class="room-name"><bdi>{name}</bdi></span>
  {#if preview}
    <span class="room-topic">
      {#if preview.sender}
        <strong class="room-preview-sender"
          >{i18n.t('nav.previewSender', { name: preview.sender })}</strong
        >
      {/if}<bdi
        ><PreviewSegments
          segments={previewSegments(preview.text, emotesShown ? preview.emotes : [])}
        /></bdi
      >
    </span>
  {:else if room?.is_direct && room.topic && preferences.showDmTopics}
    <span class="room-topic"><bdi>{room.topic}</bdi></span>
  {:else if peerStatus}
    {@const peerStatusLabel = [peerStatus.emoji, peerStatus.text].filter(Boolean).join(' ')}
    <Tooltip label={peerStatusLabel}>
      {#snippet trigger({ props })}
        <span {...props} class="room-topic">
          {#if peerStatus.emoji}<span class="room-status-emoji">{peerStatus.emoji}</span
            >{/if}{peerStatus.text}
        </span>
      {/snippet}
    </Tooltip>
  {:else if room?.room_kind === 'calendar' && preferences.showSpaceEvents}
    <CalendarRowEvent roomId={room.room_id} />
  {/if}
</span>

<style>
  .room-name,
  .room-topic {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .room-preview-sender {
    font-weight: var(--font-weight-600);
    margin-inline-end: var(--space-050);
  }

  .room-status-emoji {
    margin-inline-end: var(--space-050);
  }

  .room-topic {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-400);
    line-height: var(--line-height-small);
    margin-top: calc(-1 * var(--space-050));
    opacity: var(--opacity-p300);
  }
</style>
