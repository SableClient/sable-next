<script lang="ts">
  import type { TimelineItemView, MemberView } from '#src/generated/protocol';

  import type { MatrixLink } from './matrix-link.js';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { i18n } from '#lib/i18n.js';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { firstPreviewableLink } from './link-preview.js';
  import FormattedBody from './FormattedBody.svelte';
  import LinkEmbed from './embeds/LinkEmbed.svelte';
  import TimelineGallery from './TimelineGallery.svelte';
  import TimelineLocation from './TimelineLocation.svelte';
  import TimelineLiveLocation from './TimelineLiveLocation.svelte';
  import TimelinePoll from './TimelinePoll.svelte';

  interface Props {
    item: TimelineItemView;
    canRedactOthers: boolean;
    encrypted?: boolean | null;
    senderTimezone?: string | null;
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
    encrypted = null,
    senderTimezone = null,
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
  let spoiler = $derived(
    item.content.kind === 'image' || item.content.kind === 'video' ? item.content.spoiler : null
  );
  let spoilerKey = $derived(
    JSON.stringify([item.id, 'source' in item.content ? item.content.source : null, spoiler])
  );
  let revealedSpoiler = $state<string | null>(null);
</script>

{#if spoiler !== null && revealedSpoiler !== spoilerKey}
  <Button
    class="spoiler-reveal"
    onclick={() => {
      revealedSpoiler = spoilerKey;
    }}
  >
    {spoiler ? `${spoiler} — ` : ''}{$i18n.t('timeline.spoilerMedia')}
  </Button>
{:else if item.content.kind === 'redacted'}
  <p class="redacted">
    <TrashIcon size={14} aria-hidden="true" />
    {item.content.reason
      ? $i18n.t('timeline.redactedWithReason', { reason: item.content.reason })
      : $i18n.t('timeline.redacted')}
  </p>
{:else if item.content.kind === 'sticker'}
  <MediaImage
    class="sticker privacy-media"
    autoplay={preferences.autoplayStickers}
    source={item.content.source}
    alt={item.content.body}
    title={item.content.body}
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
    class="image privacy-media"
    source={item.content.source}
    thumbnail={item.content.thumbnail}
    alt={item.content.caption ?? item.content.filename}
    title={item.content.caption ?? item.content.filename}
    width={800}
    height={600}
    intrinsicWidth={item.content.width}
    intrinsicHeight={item.content.height}
    mime={item.content.mime}
    size={item.content.size}
    blurhash={item.content.blurhash}
    retryable
    onclick={() => item.event_id && onOpenMedia?.(item.event_id)}
  />
  {#if item.content.html}
    <FormattedBody html={item.content.html} {senderTimezone} {onMatrixLink} />
  {:else if item.content.caption}
    <p class="body">{item.content.caption}</p>
  {:else if preferences.alwaysShowAltText}
    <p class="body">{item.content.filename}</p>
  {/if}
{:else if item.content.kind === 'gallery'}
  <TimelineGallery
    items={item.content.items}
    body={item.content.body}
    html={item.content.html}
    {senderTimezone}
    {onMatrixLink}
    onOpen={item.event_id
      ? (index) => onOpenMedia?.(`${item.event_id}:gallery:${index}`)
      : undefined}
  />
{:else if item.content.kind === 'location'}
  <TimelineLocation
    body={item.content.body}
    latitude={item.content.latitude}
    longitude={item.content.longitude}
  />
{:else if item.content.kind === 'live_location'}
  <TimelineLiveLocation location={item.content} />
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
    class="media privacy-media"
    source={item.content.source}
    mime={item.content.mime}
    filename={item.content.filename}
    kind={item.content.kind}
    width={item.content.kind === 'video' ? item.content.width : null}
    height={item.content.kind === 'video' ? item.content.height : null}
    size={item.content.kind === 'file' ? item.content.size : null}
    blurhash={item.content.kind === 'video' ? item.content.blurhash : null}
    thumbnail={item.content.kind === 'video' ? item.content.thumbnail : null}
    durationMs={item.content.kind === 'audio' ? item.content.duration_ms : null}
    waveform={item.content.kind === 'audio' ? item.content.waveform : null}
    onOpen={item.event_id ? () => onOpenMedia?.(item.event_id ?? '') : undefined}
  />
  {#if item.content.html}
    <FormattedBody html={item.content.html} {senderTimezone} {onMatrixLink} />
  {:else if item.content.caption}
    <p class="body">{item.content.caption}</p>
  {/if}
{/if}
{#if previewLink}
  <LinkEmbed url={previewLink} {encrypted} />
{/if}

<style>
  .body {
    line-height: var(--line-height-body);
    margin: 0;
    white-space: pre-wrap;
  }

  .redacted {
    align-items: center;
    color: var(--surface-var-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    margin: 0;
  }

  :global(.image) {
    border-radius: var(--radius);
    display: block;
    margin-top: var(--space-100);
    max-height: var(--timeline-media-max);
    max-width: 100%;
    width: min(
      var(--timeline-media-fill),
      var(--timeline-media-max),
      max(var(--timeline-media-min), calc(var(--timeline-media-max) * var(--media-ratio)))
    );
  }

  :global(.sticker) {
    border-radius: var(--radius);
    display: block;
    margin-top: var(--space-100);
    width: var(--timeline-sticker-width);
  }

  :global(:is(.image, .sticker, .media)) + .body,
  :global(:is(.image, .sticker, .media) + .formatted-body) {
    margin-top: var(--space-200);
  }

  :global(.media) {
    max-width: 100%;
    width: min(var(--timeline-media-fill), var(--timeline-media-max));
  }

  :global(.media.media-frame-video) {
    max-height: var(--timeline-media-max);
    width: min(
      var(--timeline-media-fill),
      var(--timeline-media-max),
      max(var(--timeline-media-min), calc(var(--timeline-media-max) * var(--media-ratio)))
    );
  }
</style>
