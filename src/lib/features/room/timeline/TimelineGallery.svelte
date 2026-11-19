<script lang="ts">
  import type { GalleryItemView } from '#src/generated/protocol';
  import { SvelteSet } from 'svelte/reactivity';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { galleryItemId } from '#lib/ui/media/media-items.js';
  import {
    spoilerVisibility,
    spoilerVisibilityKey,
  } from '#lib/ui/media/spoiler-visibility.svelte.js';

  import FormattedBody from '../messages/FormattedBody.svelte';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';

  import { partitionGallery, type GalleryEntry } from './gallery-layout.js';

  interface Props {
    items: readonly GalleryItemView[];
    eventId?: string;
    body: string;
    html: string;
    senderTimezone?: string | null;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onOpen?: (index: number) => void;
  }

  let { items, eventId, body, html, senderTimezone = null, onMatrixLink, onOpen }: Props = $props();
  const revealed = new SvelteSet<string>();
  let layout = $derived(partitionGallery(items));

  function imageKey(item: GalleryItemView, index: number): string {
    return spoilerVisibilityKey(
      eventId === undefined ? String(index) : galleryItemId(eventId, index),
      item.source,
      item.kind === 'image' ? item.spoiler : null
    );
  }

  function imageHidden(item: GalleryItemView, index: number): boolean {
    return (
      item.kind === 'image' &&
      (spoilerVisibility.get(imageKey(item, index)) ?? item.spoiler !== null)
    );
  }
</script>

{#if body && preferences.captionPosition === 'above'}
  <div class="caption caption-above">
    <FormattedBody {html} {senderTimezone} {onMatrixLink} />
  </div>
{/if}
{#snippet cell({ item, index }: GalleryEntry<GalleryItemView>)}
  {@const spoiler = item.kind === 'image' || item.kind === 'video' ? item.spoiler : null}
  <div class="cell">
    <div class="frame">
      {#if item.kind === 'video' && spoiler !== null && !revealed.has(item.source)}
        <Button class="spoiler-reveal" onclick={() => revealed.add(item.source)}>
          {spoiler ? `${spoiler} — ` : ''}{i18n.t('timeline.spoilerMedia')}
        </Button>
      {:else if item.kind === 'image'}
        <MediaImage
          class="tile privacy-media"
          source={item.source}
          thumbnail={item.thumbnail}
          alt={item.caption ?? item.filename}
          title={item.caption ?? item.filename}
          width={800}
          height={600}
          intrinsicWidth={item.width}
          intrinsicHeight={item.height}
          mime={item.mime}
          size={item.size}
          blurhash={item.blurhash}
          spoilerReason={item.spoiler}
          bind:spoilerHidden={
            () => imageHidden(item, index),
            (hidden) => spoilerVisibility.set(imageKey(item, index), hidden)
          }
          spoilerName={item.filename}
          retryable
          onclick={() => onOpen?.(index)}
        />
      {:else}
        <MediaContent
          class="tile privacy-media"
          source={item.source}
          mime={item.mime}
          filename={item.filename}
          kind={item.kind}
          width={item.kind === 'video' ? item.width : null}
          height={item.kind === 'video' ? item.height : null}
          size={item.kind === 'file' ? item.size : null}
          blurhash={item.kind === 'video' ? item.blurhash : null}
          thumbnail={item.kind === 'video' ? item.thumbnail : null}
          durationMs={item.kind === 'audio' ? item.duration_ms : null}
          waveform={item.kind === 'audio' ? item.waveform : null}
          onOpen={() => onOpen?.(index)}
        />
      {/if}
    </div>
    {#if item.caption}
      <p class="item-caption">{item.caption}</p>
    {:else if item.kind === 'image' && !imageHidden(item, index) && preferences.alwaysShowAltText}
      <p class="item-caption">{item.filename}</p>
    {/if}
  </div>
{/snippet}

<div class="gallery">
  {#each layout.groups as group (group.entries[0]?.index)}
    <div class={['grid', group.layout]}>
      {#each group.entries as entry (entry.index)}
        {@render cell(entry)}
      {/each}
    </div>
  {/each}
  {#each layout.attachments as entry (entry.index)}
    {@render cell(entry)}
  {/each}
</div>
{#if body && preferences.captionPosition !== 'above' && preferences.captionPosition !== 'hidden'}
  <div class="caption"><FormattedBody {html} {senderTimezone} {onMatrixLink} /></div>
{/if}

<style>
  .gallery {
    display: grid;
    gap: var(--space-100);
    max-width: 100%;
    width: min(var(--timeline-media-fill), var(--timeline-media-max));
  }

  .grid {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .grid.one {
    grid-template-columns: minmax(0, 1fr);
  }

  .grid.three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .cell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
  }

  .grid:not(.one) .frame {
    aspect-ratio: 1;
  }

  .grid:not(.one) .frame :global(:is(.tile, .spoiler-reveal)) {
    height: 100%;
    width: 100%;
  }

  .grid.featured .cell:first-child {
    grid-row: span 2;
  }

  .grid.featured .cell:first-child .frame {
    aspect-ratio: auto;
    contain: size;
  }

  .item-caption {
    line-height: var(--line-height-body);
    margin: var(--space-100) 0 0;
    white-space: pre-wrap;
  }

  .caption {
    margin-block-start: var(--space-100);
  }

  .caption-above {
    margin-block: 0 var(--space-100);
  }
</style>
