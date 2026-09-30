<script lang="ts">
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import type { UrlPreviewView } from '#src/generated/protocol';

  import MediaImage from '#lib/ui/MediaImage.svelte';

  interface Props {
    url: string;
    preview: UrlPreviewView;
    mediaHidden: boolean;
  }

  let { url, preview, mediaHidden }: Props = $props();
  let title = $derived(preview.title ?? preview.site_name ?? url);
  let imageHidden = $derived.by(() => {
    void url;
    void preview.image;
    return false;
  });
</script>

<div class="youtube-preview">
  {#if preview.image && !mediaHidden}
    <span class="youtube-preview-image">
      <MediaImage
        source={preview.image}
        alt=""
        width={400}
        height={225}
        intrinsicWidth={preview.image_width}
        intrinsicHeight={preview.image_height}
        mime={preview.image_mime}
        bind:spoilerHidden={imageHidden}
        href={url}
      />
      {#if !imageHidden}
        <span class="youtube-preview-play" aria-hidden="true"><PlayIcon /></span>
      {/if}
    </span>
  {/if}
  <a
    class="youtube-preview-text"
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={title}
  >
    <span class="youtube-preview-site">{preview.site_name ?? 'YouTube'}</span>
    <span class="youtube-preview-title">{title}</span>
    {#if preview.description}<span class="youtube-preview-description">{preview.description}</span
      >{/if}
  </a>
</div>

<style>
  .youtube-preview {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    flex-direction: column;
    margin-top: var(--space-100);
    max-width: var(--timeline-media-max);
    overflow: hidden;
    text-decoration: none;
  }

  .youtube-preview:hover {
    border-color: var(--primary-main);
  }

  .youtube-preview-image {
    aspect-ratio: 16 / 9;
    background: var(--surface-var-container);
    display: block;
    position: relative;
  }

  .youtube-preview-image :global(img) {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .youtube-preview-play {
    align-items: center;
    background: var(--surface-container);
    border-radius: 50%;
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    display: flex;
    left: 50%;
    padding: var(--space-200);
    pointer-events: none;
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
  }

  .youtube-preview-play :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .youtube-preview-text {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-250);
    text-decoration: none;
  }

  .youtube-preview-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .youtube-preview-title {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .youtube-preview-description {
    -webkit-box-orient: vertical;
    color: var(--surface-var-on-container);
    display: -webkit-box;
    font-size: var(--font-size-small);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
</style>
