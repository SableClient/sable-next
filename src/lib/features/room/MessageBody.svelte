<script lang="ts">
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import type { MatrixLink } from './matrix-link.js';

  import type { MemberView } from '#src/generated/MemberView';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { firstPreviewableLink } from './link-preview.js';
  import LinkPreviewCard from './LinkPreviewCard.svelte';
  import { isCaption } from './members.js';
  import TimelineGallery from './TimelineGallery.svelte';
  import TimelineLocation from './TimelineLocation.svelte';
  import TimelinePoll from './TimelinePoll.svelte';

  interface Props {
    item: TimelineItemView;
    canRedactOthers: boolean;
    members?: readonly MemberView[];
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onOpenMedia?: (eventId: string) => void;
    onVotePoll?: (eventId: string, answers: string[]) => void;
    onEndPoll?: (eventId: string) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    item,
    canRedactOthers,
    members = [],
    onMatrixLink,
    onOpenMedia,
    onVotePoll,
    onEndPoll,
    onSenderProfile,
  }: Props = $props();
  let previewLink = $derived(
    item.content.kind === 'gallery' ? firstPreviewableLink(item.content.html) : null
  );
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
  {#if preferences.alwaysShowAltText}<p class="body">{item.content.body}</p>{/if}
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
  {#if isCaption(item.content.body) || preferences.alwaysShowAltText}<p class="body">
      {item.content.body}
    </p>{/if}
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
    {members}
    onVote={onVotePoll}
    onEnd={onEndPoll}
    {onSenderProfile}
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
    durationMs={item.content.kind === 'audio' ? item.content.duration_ms : null}
    waveform={item.content.kind === 'audio' ? item.content.waveform : null}
    onOpen={item.event_id ? () => onOpenMedia?.(item.event_id ?? '') : undefined}
  />
{/if}
{#if previewLink}
  <LinkPreviewCard url={previewLink} />
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
