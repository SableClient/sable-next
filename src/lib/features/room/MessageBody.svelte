<script lang="ts">
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import type { MatrixLink } from './matrix-link.js';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { isCaption } from './members.js';
  import TimelineGallery from './TimelineGallery.svelte';
  import TimelineLocation from './TimelineLocation.svelte';
  import TimelinePoll from './TimelinePoll.svelte';

  interface Props {
    item: TimelineItemView;
    canRedactOthers: boolean;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onOpenMedia?: (eventId: string) => void;
    onVotePoll?: (eventId: string, answers: string[]) => void;
    onEndPoll?: (eventId: string) => void;
  }

  let { item, canRedactOthers, onMatrixLink, onOpenMedia, onVotePoll, onEndPoll }: Props = $props();
</script>

{#if item.content.kind === 'sticker'}
  <MediaImage
    class="sticker"
    source={item.content.source}
    alt={item.content.body}
    width={304}
    height={304}
    intrinsicWidth={item.content.width}
    intrinsicHeight={item.content.height}
    mime={item.content.mime}
    retryable
    onclick={() => item.event_id && onOpenMedia?.(item.event_id)}
  />
{:else if item.content.kind === 'image'}
  <MediaImage
    class="image"
    source={item.content.source}
    alt={item.content.body}
    width={800}
    height={600}
    intrinsicWidth={item.content.width}
    intrinsicHeight={item.content.height}
    mime={item.content.mime}
    blurhash={item.content.blurhash}
    retryable
    onclick={() => item.event_id && onOpenMedia?.(item.event_id)}
  />
  {#if isCaption(item.content.body)}<p class="body">{item.content.body}</p>{/if}
{:else if item.content.kind === 'gallery'}
  <TimelineGallery
    items={item.content.items}
    body={item.content.body}
    html={item.content.html}
    {onMatrixLink}
  />
{:else if item.content.kind === 'location'}
  <TimelineLocation
    body={item.content.body}
    geoUri={item.content.geo_uri}
    latitude={item.content.latitude}
    longitude={item.content.longitude}
  />
{:else if item.content.kind === 'poll'}
  <TimelinePoll
    poll={item.content.poll}
    eventId={item.event_id}
    canEnd={item.is_own || canRedactOthers}
    onVote={onVotePoll}
    onEnd={onEndPoll}
  />
{:else if item.content.kind === 'video' || item.content.kind === 'audio' || item.content.kind === 'file'}
  <MediaContent
    class="media"
    source={item.content.source}
    mime={item.content.mime}
    body={item.content.body}
    kind={item.content.kind}
    width={item.content.kind === 'video' ? item.content.width : null}
    height={item.content.kind === 'video' ? item.content.height : null}
    size={item.content.kind === 'file' ? item.content.size : null}
    blurhash={item.content.kind === 'video' ? item.content.blurhash : null}
  />
{/if}

<style>
  .body {
    line-height: var(--line-height-body);
    margin: 0;
    white-space: pre-wrap;
  }

  :global(.image) {
    border-radius: var(--radius);
    display: block;
    margin-top: var(--space-100);
    width: min(
      100%,
      var(--timeline-media-max),
      calc(var(--timeline-media-max) * var(--media-ratio))
    );
  }

  :global(.sticker) {
    border-radius: var(--radius);
    display: block;
    margin-top: var(--space-100);
    width: var(--timeline-sticker-width);
  }

  :global(.media) {
    width: min(100%, var(--timeline-media-max));
  }
</style>
