<script lang="ts">
  import type {
    MemberView,
    PerMessageProfileView,
    TimelineItemView,
  } from '#src/generated/protocol';
  import type { Snippet } from 'svelte';

  import MessageScope from './MessageScope.svelte';
  import TimelineItem from '../timeline/TimelineItem.svelte';
  import { useEventItems } from './event-items.svelte.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { TIMELINE_LAYOUT_STYLE, timelineLayoutStyle } from '../timeline/timeline-layout';
  import { isCollapsed } from '../timeline/timeline-format';
  import { preferences } from '#lib/settings/preferences.svelte.js';

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
    onSenderProfile?: (
      userId: string,
      anchor: HTMLElement,
      pmp?: PerMessageProfileView | null
    ) => void;
    previousEventId?: string;
    timeline?: boolean;
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
    onSenderProfile,
    previousEventId,
    timeline = false,
  }: Props = $props();

  const eventItems = useEventItems();
  let shown = $derived(item ?? eventItems.get(roomId, eventId) ?? null);
  let previous = $derived(previousEventId ? eventItems.get(roomId, previousEventId) : null);
  let collapsed = $derived(
    shown && previous ? isCollapsed([previous, shown], 1, preferences.replyPreviewStyle) : false
  );
</script>

<div
  class={['message-preview', { timeline, collapsed, 'group-start': previousEventId && !collapsed }]}
  style={timeline ? timelineLayoutStyle(preferences.messageSpacing) : TIMELINE_LAYOUT_STYLE}
>
  {#if shown}
    {#key roomId}
      <MessageScope {roomId}>
        <TimelineItem
          item={shown}
          {collapsed}
          preview
          {headerAction}
          {loadPreviewProfile}
          {timeAction}
          {roomId}
          {members}
          layout={timeline ? preferences.layout : 'modern'}
          alignOwn={timeline && preferences.alignOwnMessages}
          {onMatrixLink}
          {onJumpToEvent}
          {onOpenMedia}
          {onSenderProfile}
        />
      </MessageScope>
    {/key}
  {:else}
    {@render fallback()}
  {/if}
</div>

<style>
  .message-preview {
    --timeline-media-fill: 100%;
    --timeline-bubble-width: 100%;

    min-width: 0;
  }

  .message-preview:not(.timeline) {
    --page-gutter: 0px;
  }

  .timeline {
    box-sizing: border-box;
    padding: var(--timeline-row-padding) var(--page-gutter);
    width: 100%;
  }

  .timeline.collapsed {
    padding-top: 0;
  }

  .timeline.group-start {
    padding-top: calc(var(--timeline-row-padding) + var(--timeline-group-gap));
  }

  @media (width >= 30rem) {
    .timeline {
      --timeline-media-fill: var(--timeline-media-max);
      --timeline-bubble-width: fit-content;
    }
  }

  @media (width >= 48rem) and (any-hover: hover) and (any-pointer: fine) {
    .timeline {
      --line-height-body: 1.47;
    }
  }

  .message-preview:not(.timeline) :global(.message:hover) {
    background-color: transparent;
  }
</style>
