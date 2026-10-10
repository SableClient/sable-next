<script lang="ts">
  import { on } from 'svelte/events';
  import type { TimelineItemView, MemberView } from '#src/generated/protocol';

  import type { MatrixLink } from '#lib/rooms/matrix-link.js';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { i18n } from '#lib/i18n.js';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { previewableLinks } from '../media/link-preview.js';
  import FormattedBody from './FormattedBody.svelte';
  import EmoteCard from './EmoteCard.svelte';
  import LinkEmbed from '../media/embeds/LinkEmbed.svelte';
  import TimelineGallery from '../timeline/TimelineGallery.svelte';
  import { galleryItemId } from '../media/media-items.js';
  import TimelineLocation from '../timeline/TimelineLocation.svelte';
  import TimelineLiveLocation from '../timeline/TimelineLiveLocation.svelte';
  import TimelinePoll from '../timeline/TimelinePoll.svelte';
  import {
    hasRoomMediaPreviews,
    useRoomMediaPreviews,
  } from '../media/room-media-previews.svelte.js';

  const HIDEABLE_MEDIA = ['image', 'video', 'sticker', 'gallery'];
  const roomMedia = hasRoomMediaPreviews() ? useRoomMediaPreviews() : null;

  interface Props {
    item: TimelineItemView;
    canRedactOthers: boolean;
    redactionReason?: string | null;
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
    redactionReason = null,
    encrypted = null,
    senderTimezone = null,
    members = [],
    onMatrixLink,
    onOpenMedia,
    onVotePoll,
    onEndPoll,
    onSenderProfile,
  }: Props = $props();
  let previewLinks = $derived(
    item.content.kind === 'gallery' && item.link_previews_removed !== true
      ? previewableLinks(item.content.html)
      : []
  );
  let spoiler = $derived(
    item.content.kind === 'image' || item.content.kind === 'video' ? item.content.spoiler : null
  );
  let hiddenByPolicy = $derived(
    (roomMedia?.hidden ?? false) && HIDEABLE_MEDIA.includes(item.content.kind)
  );
  let spoilerKey = $derived(
    JSON.stringify([item.id, 'source' in item.content ? item.content.source : null, spoiler])
  );
  let revealedSpoiler = $state<string | null>(null);
  let imageSpoilerHidden = $derived.by(() => {
    void spoilerKey;
    return spoiler !== null;
  });
  let showCaption = $derived(preferences.captionPosition !== 'hidden');
  let stickerAnchor = $state<HTMLElement | null>(null);
  let stickerHovered = $state(false);

  function dismissStickerTooltip(node: HTMLElement) {
    return on(node, 'keydown', (event) => {
      if (event.key === 'Escape') stickerHovered = false;
    });
  }
</script>

{#if ((item.content.kind !== 'image' && spoiler !== null) || hiddenByPolicy) && revealedSpoiler !== spoilerKey}
  <Button
    class="spoiler-reveal"
    onclick={() => {
      revealedSpoiler = spoilerKey;
    }}
  >
    {spoiler ? `${spoiler} — ` : ''}{$i18n.t(
      spoiler === null ? 'timeline.hiddenMedia' : 'timeline.spoilerMedia'
    )}
  </Button>
  {#if item.content.kind === 'video' && showCaption && item.content.html}
    <FormattedBody html={item.content.html} {senderTimezone} {onMatrixLink} />
  {:else if item.content.kind === 'video' && showCaption && item.content.caption}
    <p class="body">{item.content.caption}</p>
  {/if}
{:else if item.content.kind === 'redacted'}
  {@const reason = item.content.reason ?? redactionReason}
  <p class="redacted">
    <TrashIcon size={14} aria-hidden="true" />
    {reason ? $i18n.t('timeline.redactedWithReason', { reason }) : $i18n.t('timeline.redacted')}
  </p>
{:else if item.content.kind === 'sticker'}
  {@const sticker = item.content}
  <div
    class="sticker"
    role="group"
    aria-label={sticker.body}
    bind:this={stickerAnchor}
    onpointerenter={(event) => (stickerHovered = event.pointerType !== 'touch')}
    onpointerleave={() => (stickerHovered = false)}
    onfocusin={() => (stickerHovered = true)}
    onfocusout={() => (stickerHovered = false)}
    {@attach dismissStickerTooltip}
  >
    <MediaImage
      class="privacy-media"
      autoplay={preferences.autoplayStickers}
      source={sticker.source}
      alt={sticker.body}
      width={304}
      height={304}
      intrinsicWidth={sticker.width}
      intrinsicHeight={sticker.height}
      mime={sticker.mime}
      bind:spoilerHidden={imageSpoilerHidden}
      retryable
      onclick={() => item.event_id && onOpenMedia?.(item.event_id)}
    />
  </div>
  {#if stickerHovered && !imageSpoilerHidden}
    <Tooltip label={sticker.body} open customAnchor={stickerAnchor} side="top">
      {#snippet content()}
        <EmoteCard label={sticker.body}>
          <MediaImage
            source={sticker.source}
            alt=""
            width={64}
            height={64}
            mime={sticker.mime}
            original
            autoplay={preferences.autoplayStickers}
          />
        </EmoteCard>
      {/snippet}
    </Tooltip>
  {/if}
  {#if !imageSpoilerHidden && preferences.alwaysShowAltText}<p class="body">
      {item.content.body}
    </p>{/if}
{:else if item.content.kind === 'image'}
  <div class={['captioned', `caption-${preferences.captionPosition}`]}>
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
      animatedHint={item.content.animated}
      size={item.content.size}
      blurhash={item.content.blurhash}
      spoilerReason={item.content.spoiler}
      bind:spoilerHidden={imageSpoilerHidden}
      spoilerName={item.content.filename}
      retryable
      onclick={() => item.event_id && onOpenMedia?.(item.event_id)}
    />
    {#if showCaption && item.content.html}
      <FormattedBody html={item.content.html} {senderTimezone} {onMatrixLink} />
    {:else if showCaption && item.content.caption}
      <p class="body">{item.content.caption}</p>
    {:else if !imageSpoilerHidden && !item.content.caption && preferences.alwaysShowAltText}
      <p class="body">{item.content.filename}</p>
    {/if}
  </div>
{:else if item.content.kind === 'gallery'}
  <TimelineGallery
    items={item.content.items}
    body={item.content.body}
    html={item.content.html}
    {senderTimezone}
    {onMatrixLink}
    onOpen={item.event_id
      ? (index) => onOpenMedia?.(galleryItemId(item.event_id ?? '', index))
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
  <div class={['captioned', `caption-${preferences.captionPosition}`]}>
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
      audioMetadata={item.content.kind === 'audio' ? item.content.metadata : null}
      onOpen={item.event_id ? () => onOpenMedia?.(item.event_id ?? '') : undefined}
    />
    {#if showCaption && item.content.html}
      <FormattedBody html={item.content.html} {senderTimezone} {onMatrixLink} />
    {:else if showCaption && item.content.caption}
      <p class="body">{item.content.caption}</p>
    {/if}
  </div>
{/if}
{#if item.content.kind === 'gallery' && item.bundled_link_previews.length > 0}
  {#each item.bundled_link_previews as preview (preview.url)}
    <LinkEmbed url={preview.url} bundled={preview} {encrypted} />
  {/each}
{:else}
  {#each previewLinks as url (url)}
    <LinkEmbed {url} {encrypted} />
  {/each}
{/if}

<style>
  .body {
    line-height: var(--line-height-body);
    margin: 0;
    white-space: pre-wrap;
  }

  .captioned {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
  }

  .captioned > .body,
  .captioned > :global(.formatted-body) {
    margin-top: 0;
  }

  .caption-above {
    flex-direction: column-reverse;
  }

  .caption-above > :global(.image) {
    margin-top: 0;
  }

  .caption-inline {
    align-items: center;
    flex-flow: row wrap;
  }

  .caption-inline > .body,
  .caption-inline > :global(.formatted-body) {
    flex: 1 1 12rem;
    min-width: 0;
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
      max(
        var(--timeline-media-min),
        min(calc(var(--timeline-media-max) * var(--media-ratio)), var(--media-width, 100rem))
      )
    );
  }

  :global(.sticker) {
    border-radius: var(--radius);
    display: block;
    margin-top: var(--space-100);
    max-width: 100%;
    width: var(--timeline-sticker-width);
  }

  :global(.sticker) + .body {
    margin-top: var(--space-200);
  }

  :global(.media) {
    max-width: 100%;
    width: min(var(--timeline-media-fill), var(--timeline-media-max));
  }

  :global(.media.media-frame-video) {
    contain: inline-size;
    contain-intrinsic-inline-size: var(--timeline-media-max);
    max-height: var(--timeline-media-max);
    width: min(
      var(--timeline-media-fill),
      var(--timeline-media-max),
      max(var(--timeline-media-min), calc(var(--timeline-media-max) * var(--media-ratio)))
    );
  }
</style>
