<script lang="ts">
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import type { Snippet } from 'svelte';

  import MessageScope from './MessageScope.svelte';
  import TimelineItem from './TimelineItem.svelte';
  import { useEventItems } from './event-items.svelte.js';
  import type { MatrixLink } from './matrix-link';
  import { TIMELINE_LAYOUT_STYLE } from './timeline-layout';

  interface Props {
    roomId: string;
    eventId: string;
    item?: TimelineItemView | null;
    members?: readonly MemberView[];
    fallback: Snippet;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onJumpToEvent?: (eventId: string) => void;
  }

  let {
    roomId,
    eventId,
    item = null,
    members = [],
    fallback,
    onMatrixLink,
    onJumpToEvent,
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
          {roomId}
          {members}
          layout="modern"
          alignOwn={false}
          {onMatrixLink}
          {onJumpToEvent}
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
