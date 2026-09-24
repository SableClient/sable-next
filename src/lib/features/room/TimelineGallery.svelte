<script lang="ts">
  import type { GalleryItemView } from '#src/generated/protocol';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';

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
</script>

<div class="gallery" style:--gallery-columns={columns}>
  {#each items as item, index (index)}
    {#if item.kind === 'image'}
      <MediaImage
        class="tile privacy-media"
        source={item.source}
        thumbnail={item.thumbnail}
        alt={item.body}
        width={800}
        height={600}
        intrinsicWidth={item.width}
        intrinsicHeight={item.height}
        mime={item.mime}
        blurhash={item.blurhash}
        retryable
        onclick={() => onOpen?.(index)}
      />
    {:else}
      <MediaContent
        class="tile privacy-media"
        source={item.source}
        mime={item.mime}
        filename={item.body}
        kind={item.kind}
        width={item.kind === 'video' ? item.width : null}
        height={item.kind === 'video' ? item.height : null}
        blurhash={item.kind === 'video' ? item.blurhash : null}
        thumbnail={item.kind === 'video' ? item.thumbnail : null}
      />
    {/if}
  {/each}
</div>
{#if body}
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

  .caption {
    margin-block-start: var(--space-100);
  }
</style>
