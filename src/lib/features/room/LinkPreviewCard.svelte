<script lang="ts">
  import type { UrlPreviewView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { imageMimeFromUrl } from './link-preview.js';
  import { loadUrlPreview } from './link-preview-cache';

  interface Props {
    url: string;
    encrypted: boolean | null;
    bundled?: UrlPreviewView | null;
  }

  let { url, encrypted, bundled = null }: Props = $props();
  const core = useCoreClient();
  let preview = $state<UrlPreviewView | null>(null);
  let allowed = $derived(
    encrypted === false ? preferences.urlPreviews : preferences.encryptedUrlPreviews
  );

  $effect(() => {
    if (bundled !== null) {
      preview = bundled;
      return;
    }
    if (!allowed) {
      preview = null;
      return;
    }

    let cancelled = false;
    preview = null;
    void loadUrlPreview(core.commands, url).then((result) => {
      if (!cancelled) preview = result;
    });
    return () => {
      cancelled = true;
    };
  });

  let title = $derived(preview?.title ?? preview?.site_name ?? url);
</script>

{#if preview?.image && preview.title === null && preview.site_name === null}
  <a class="link-preview-link" href={url} target="_blank" rel="noopener noreferrer">
    <MediaImage
      class="link-preview-inline"
      source={preview.image}
      alt={preview.description ?? ''}
      width={400}
      height={300}
      intrinsicWidth={preview.image_width}
      intrinsicHeight={preview.image_height}
      mime={preview.image_mime ?? imageMimeFromUrl(url)}
    />
  </a>
{:else if preview}
  <a class="link-preview" href={url} target="_blank" rel="noopener noreferrer" aria-label={title}>
    {#if preview.image}
      <MediaImage
        class="link-preview-image"
        source={preview.image}
        alt=""
        width={400}
        height={225}
        intrinsicWidth={preview.image_width}
        intrinsicHeight={preview.image_height}
      />
    {/if}
    <span class="link-preview-text">
      {#if preview.site_name}<span class="link-preview-site">{preview.site_name}</span>{/if}
      <span class="link-preview-title">{title}</span>
      {#if preview.description}
        <span class="link-preview-description">{preview.description}</span>
      {/if}
    </span>
  </a>
{/if}

<style>
  .link-preview-link {
    display: block;
    margin-top: var(--space-100);
    max-width: var(--timeline-media-max);
  }

  :global(.link-preview-inline) {
    border-radius: var(--radius);
  }

  .link-preview {
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

  .link-preview:hover {
    border-color: var(--primary-main);
  }

  :global(.link-preview-image) {
    display: block;
    width: 100%;
  }

  .link-preview-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-250);
  }

  .link-preview-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .link-preview-title {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-preview-description {
    -webkit-box-orient: vertical;
    color: var(--surface-var-on-container);
    display: -webkit-box;
    font-size: var(--font-size-small);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
</style>
