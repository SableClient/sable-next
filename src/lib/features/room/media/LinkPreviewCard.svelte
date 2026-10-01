<script lang="ts">
  import type { UrlPreviewView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { imageMimeFromUrl } from './link-preview.js';
  import { loadUrlPreview } from './link-preview-cache';
  import { findLinkPresentation } from './link-presentations';
  import { hasMediaViewerOpener, useMediaViewerOpener } from './media-viewer-opener.svelte.js';
  import { hasRoomMediaPreviews, useRoomMediaPreviews } from './room-media-previews.svelte.js';

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
  const roomMedia = hasRoomMediaPreviews() ? useRoomMediaPreviews() : null;
  let mediaHidden = $derived(roomMedia?.hidden ?? false);
  const openMediaViewer = hasMediaViewerOpener() ? useMediaViewerOpener() : null;
  let Presentation = $derived(preview && findLinkPresentation(url, preview));
  let imageHidden = $derived.by(() => {
    void url;
    void preview?.image;
    return false;
  });

  function openPreviewImage(): void {
    if (openMediaViewer === null || preview === null || preview.image === null) return;
    openMediaViewer({
      kind: 'image',
      filename: url,
      caption: null,
      html: null,
      source: preview.image,
      mime: preview.image_mime ?? imageMimeFromUrl(url),
      width: preview.image_width,
      height: preview.image_height,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      animated: null,
      sender: url,
    });
  }
</script>

{#if preview && Presentation}
  <Presentation {url} {preview} {mediaHidden} />
{:else if preview?.image && !mediaHidden && preview.title === null && preview.site_name === null}
  <MediaImage
    class="link-preview-inline"
    source={preview.image}
    alt={preview.description ?? ''}
    width={400}
    height={300}
    intrinsicWidth={preview.image_width}
    intrinsicHeight={preview.image_height}
    mime={preview.image_mime ?? imageMimeFromUrl(url)}
    bind:spoilerHidden={imageHidden}
    href={url}
    onclick={openMediaViewer ? openPreviewImage : undefined}
  />
{:else if preview}
  <div class="link-preview">
    {#if preview.image && !mediaHidden}
      <MediaImage
        class="link-preview-image"
        source={preview.image}
        alt=""
        width={400}
        height={225}
        intrinsicWidth={preview.image_width}
        intrinsicHeight={preview.image_height}
        bind:spoilerHidden={imageHidden}
        href={url}
        onclick={openMediaViewer ? openPreviewImage : undefined}
      />
    {/if}
    <a
      class="link-preview-text"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={title}
    >
      {#if preview.site_name}<span class="link-preview-site">{preview.site_name}</span>{/if}
      <span class="link-preview-title">{title}</span>
      {#if preview.description}
        <span class="link-preview-description">{preview.description}</span>
      {/if}
    </a>
  </div>
{/if}

<style>
  :global(.link-preview-inline) {
    border-radius: var(--radius);
    margin-top: var(--space-100);
    max-width: min(var(--timeline-media-max), 100%);
  }

  .link-preview {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: flex;
    flex-direction: column;
    margin-top: var(--space-100);
    max-width: min(var(--timeline-media-max), 100%);
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
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-250);
    text-decoration: none;
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
