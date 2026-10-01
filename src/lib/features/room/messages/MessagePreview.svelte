<script lang="ts">
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import type { Snippet } from 'svelte';

  import MessageScope from './MessageScope.svelte';
  import TimelineItem from '../timeline/TimelineItem.svelte';
  import { useEventItems } from './event-items.svelte.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { TIMELINE_LAYOUT_STYLE } from '../timeline/timeline-layout';

  interface Props {
    roomId: string;
    eventId: string;
    item?: TimelineItemView | null;
    members?: readonly MemberView[];
    fallback: Snippet;
    headerAction?: Snippet;
    loadPreviewProfile?: boolean;
    timeAction?: { label: string; run: () => void };
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onJumpToEvent?: (eventId: string) => void;
    onOpenMedia?: (eventId: string) => void;
  }

  let {
    roomId,
    eventId,
    item = null,
    members = [],
    fallback,
    headerAction,
    loadPreviewProfile,
    timeAction,
    onMatrixLink,
    onJumpToEvent,
    onOpenMedia,
  }: Props = $props();

  const eventItems = useEventItems();
  let shown = $derived(item ?? eventItems.get(roomId, eventId) ?? null);
</script>

<div class="message-preview" style={TIMELINE_LAYOUT_STYLE}>
  {#if shown}
    {#key roomId}
      <MessageScope {roomId}>
        <TimelineItem
          item={shown}
          collapsed={false}
          preview
          {headerAction}
          {loadPreviewProfile}
          {timeAction}
          {roomId}
          {members}
          layout="modern"
          alignOwn={false}
          {onMatrixLink}
          {onJumpToEvent}
          {onOpenMedia}
        />
      </MessageScope>
    {/key}
  {:else}
    {@render fallback()}
  {/if}
</div>

<style>
  .message-preview {
    --page-gutter: 0px;
    --timeline-media-fill: 100%;
    --timeline-bubble-width: 100%;

    min-width: 0;
  }

  .message-preview :global(.message:hover) {
    background-color: transparent;
  }
</style>
