<script lang="ts">
  import type { GalleryItemView } from '#src/generated/GalleryItemView';

  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import type { MatrixLink } from './matrix-link';

  interface Props {
    items: readonly GalleryItemView[];
    body: string;
    html: string;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { items, body, html, onMatrixLink }: Props = $props();
  let columns = $derived(items.length > 1 ? 2 : 1);
</script>

<div class="gallery" style:--gallery-columns={columns}>
  {#each items as item, index (index)}
    {#if item.kind === 'image'}
      <MediaImage
        class="tile"
        source={item.source}
        alt={item.body}
        width={800}
        height={600}
        intrinsicWidth={item.width}
        intrinsicHeight={item.height}
        mime={item.mime}
        retryable
      />
    {:else}
      <MediaContent
        class="tile"
        source={item.source}
        mime={item.mime}
        body={item.body}
        kind={item.kind}
        width={item.kind === 'video' ? item.width : null}
        height={item.kind === 'video' ? item.height : null}
      />
    {/if}
  {/each}
</div>
{#if body}
  <div class="caption"><FormattedBody {html} {onMatrixLink} /></div>
{/if}

<style>
  .gallery {
    display: grid;
    gap: 0.25rem;
    grid-template-columns: repeat(var(--gallery-columns), minmax(0, 1fr));
    max-width: var(--timeline-media-max);
  }

  .caption {
    margin-block-start: 0.25rem;
  }
</style>
