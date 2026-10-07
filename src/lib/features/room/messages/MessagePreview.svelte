<script lang="ts">
  import type {
    MemberView,
    PerMessageProfileView,
    TimelineItemView,
  } from '#src/generated/protocol';
  import type { Snippet } from 'svelte';
  import { on } from 'svelte/events';

  import MessageScope from './MessageScope.svelte';
  import TimelineItem from '../timeline/TimelineItem.svelte';
  import { useEventItems } from './event-items.svelte.js';
  import { opensFrom } from './message-preview';
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

  function openMessage(node: HTMLElement): () => void {
    return on(node, 'click', (event) => {
      if (!event.defaultPrevented && event.button === 0 && opensFrom(event))
        onJumpToEvent?.(eventId);
    });
  }
</script>

<div
  class={['message-preview', { timeline, collapsed, 'group-start': previousEventId && !collapsed }]}
  class:clickable={timeline && onJumpToEvent !== undefined}
  style={timeline ? timelineLayoutStyle(preferences.messageSpacing) : TIMELINE_LAYOUT_STYLE}
  {@attach timeline && onJumpToEvent ? openMessage : undefined}
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

  .clickable {
    cursor: pointer;
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
