<script lang="ts">
  import type { GalleryItemView } from '#src/generated/protocol';
  import { SvelteSet } from 'svelte/reactivity';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  import FormattedBody from './FormattedBody.svelte';
  import type { MatrixLink } from './matrix-link';

  interface Props {
    items: readonly GalleryItemView[];
    body: string;
    html: string;
    senderTimezone?: string | null;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onOpen?: (index: number) => void;
  }

  let { items, body, html, senderTimezone = null, onMatrixLink, onOpen }: Props = $props();
  let columns = $derived(items.length > 1 ? 2 : 1);
  const revealed = new SvelteSet<string>();
</script>

{#if body && preferences.captionPosition === 'above'}
  <div class="caption caption-above">
    <FormattedBody {html} {senderTimezone} {onMatrixLink} />
  </div>
{/if}
<div class="gallery" style:--gallery-columns={columns}>
  {#each items as item, index (index)}
    {@const spoiler = item.kind === 'image' || item.kind === 'video' ? item.spoiler : null}
    <div class="cell">
      {#if spoiler !== null && !revealed.has(item.source)}
        <Button class="spoiler-reveal" onclick={() => revealed.add(item.source)}>
          {spoiler ? `${spoiler} — ` : ''}{$i18n.t('timeline.spoilerMedia')}
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
      {#if item.caption}
        <p class="item-caption">{item.caption}</p>
      {:else if item.kind === 'image' && preferences.alwaysShowAltText}
        <p class="item-caption">{item.filename}</p>
      {/if}
    </div>
  {/each}
</div>
{#if body && preferences.captionPosition !== 'above' && preferences.captionPosition !== 'hidden'}
  <div class="caption"><FormattedBody {html} {senderTimezone} {onMatrixLink} /></div>
{/if}

<style>
  .gallery {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(var(--gallery-columns), minmax(0, 1fr));
    max-width: 100%;
    width: min(var(--timeline-media-fill), var(--timeline-media-max));
  }

  .cell {
    display: grid;
    min-width: 0;
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
