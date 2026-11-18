<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import type { MediaItem } from './media-viewer-types';

  interface Props {
    preview: Extract<MediaItem, { kind: 'image' }> | null;
    percent: number | null;
  }

  let { preview, percent }: Props = $props();
</script>

{#if preview}
  <MediaImage
    class="viewer-preview"
    style={[
      preview.width ? `--preview-width: ${String(preview.width)}px` : '',
      preview.height ? `--preview-height: ${String(preview.height)}px` : '',
    ].join(';')}
    source={preview.source}
    thumbnail={preview.thumbnail}
    alt=""
    width={800}
    height={600}
    intrinsicWidth={preview.width}
    intrinsicHeight={preview.height}
    mime={preview.mime}
    blurhash={preview.blurhash}
  />
{/if}
<span class="loading">
  <Spinner label={i18n.t('a11y.loading')} />
  {#if percent !== null}
    <span>{i18n.t('timeline.downloadProgress', { percent })}</span>
  {/if}
</span>

<style>
  .loading {
    align-items: center;
    background: var(--surface-container);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-100) var(--space-200);
    position: relative;
  }
</style>
