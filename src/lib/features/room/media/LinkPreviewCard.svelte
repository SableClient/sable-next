<script lang="ts">
  import type { UrlPreviewView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { GIF_PLAYBACK, hasPreviewData, imageMimeFromUrl } from './link-preview.js';
  import { previewSources, resolveUrlPreview } from './link-preview-cache';
  import { findLinkPresentation } from './link-presentations';
  import { hasRoomMediaPreviews, useRoomMediaPreviews } from './room-media-previews.svelte.js';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';

  interface Props {
    url: string;
    encrypted: boolean | null;
    bundled?: UrlPreviewView | null;
  }

  let { url, encrypted, bundled = null }: Props = $props();
  const core = useCoreClient();
  let preview = $state<UrlPreviewView | null>(null);
  let resolvedUrl: string | null = null;
  let sources = $derived(previewSources(encrypted));

  $effect(() => {
    if (bundled !== null && hasPreviewData(bundled)) {
      preview =
        preferences.urlPreviews || preferences.clientEmbeds || sources.server ? bundled : null;
      resolvedUrl = null;
      return;
    }
    if (!sources.server && !sources.client) {
      preview = null;
      resolvedUrl = null;
      return;
    }

    let cancelled = false;
    const wanted = url;
    if (resolvedUrl !== wanted) preview = null;
    void resolveUrlPreview(core.rpc.messages, wanted, sources).then((result) => {
      if (cancelled) return;
      preview = result;
      resolvedUrl = wanted;
    });
    return () => {
      cancelled = true;
    };
  });

  let shown = $derived(preview ? [preview] : []);
  let title = $derived(preview?.title ?? preview?.site_name ?? url);
  let compactImage = $derived(
    preview?.card === 'summary'
      ? true
      : preview?.card === 'summary_large_image'
        ? false
        : preview?.image_width != null &&
          preview.image_height != null &&
          preview.image_width > 0 &&
          preview.image_width <= preview.image_height
  );
  const roomMedia = hasRoomMediaPreviews() ? useRoomMediaPreviews() : null;
  let mediaHidden = $derived(roomMedia?.hidden ?? false);
  let Presentation = $derived(preview && findLinkPresentation(url, preview));
  let videoPlayback = $derived.by(() => {
    if (!preview?.video?.gif && preview?.image_mime !== 'image/gif') return null;
    return preferences.autoplayGifs
      ? GIF_PLAYBACK
      : { ...GIF_PLAYBACK, gif: false, autoplay: false };
  });
  let imageHidden = $derived.by(() => {
    void url;
    void preview?.image;
    return false;
  });

  function openPreviewImage(): void {
    if (preview === null || preview.image === null) return;
    mediaViewerState.openStandalone(
      preview.image,
      url,
      preview.image_mime ?? imageMimeFromUrl(url),
      preview.image_width,
      preview.image_height
    );
  }
</script>

<!-- An each block holds its item through teardown, where a getter reading `preview` would see null. -->
{#each shown as view, index (index)}
  {#if Presentation}
    <Presentation {url} preview={view} {mediaHidden} />
  {:else if view.video && !mediaHidden && view.title === null && view.site_name === null}
    <MediaContent
      class="link-preview-inline"
      source={view.video.source}
      mime={view.video.mime}
      filename={url}
      kind="video"
      width={view.video.width}
      height={view.video.height}
      thumbnail={view.image}
      thumbnailMime={view.image_mime}
      playback={videoPlayback}
    />
  {:else if view.image && !mediaHidden && view.title === null && view.site_name === null}
    <MediaImage
      class="link-preview-inline"
      source={view.image}
      alt={view.description ?? ''}
      width={400}
      height={300}
      intrinsicWidth={view.image_width}
      intrinsicHeight={view.image_height}
      mime={view.image_mime ?? imageMimeFromUrl(url)}
      bind:spoilerHidden={imageHidden}
      href={url}
      onclick={openPreviewImage}
    />
  {:else}
    <div
      class={[
        'link-preview',
        { compact: compactImage && !view.video, accented: view.theme_color !== null },
      ]}
      style:--link-preview-accent={view.theme_color}
    >
      {#if view.video && !mediaHidden}
        <MediaContent
          class="link-preview-video"
          source={view.video.source}
          mime={view.video.mime}
          filename={url}
          kind="video"
          width={view.video.width}
          height={view.video.height}
          thumbnail={view.image}
          thumbnailMime={view.image_mime}
          playback={videoPlayback}
        />
      {:else if view.image && !mediaHidden}
        <MediaImage
          class="link-preview-image"
          source={view.image}
          alt=""
          width={compactImage ? 80 : 400}
          height={compactImage ? 80 : 225}
          intrinsicWidth={view.image_width}
          intrinsicHeight={view.image_height}
          bind:spoilerHidden={imageHidden}
          href={url}
          onclick={openPreviewImage}
        />
      {/if}
      <a
        class="link-preview-text"
        href={url}
        target="_blank"
        rel="external noopener noreferrer"
        aria-label={title}
      >
        {#if view.site_name}<span class="link-preview-site">{view.site_name}</span>{/if}
        {#if view.author_name}<span class="link-preview-author">{view.author_name}</span>{/if}
        <span class="link-preview-title">{title}</span>
        {#if view.description}
          <span class="link-preview-description">{view.description}</span>
        {/if}
      </a>
    </div>
  {/if}
{/each}

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

  .link-preview.accented {
    border-inline-start: var(--space-100) solid var(--link-preview-accent);
  }

  .link-preview:hover {
    border-color: var(--primary-main);
  }

  .link-preview.compact {
    flex-direction: row-reverse;
  }

  .compact :global(.link-preview-image) {
    flex: 0 0 5rem;
    height: 5rem;
    margin: var(--space-200);
    width: 5rem;
  }

  :global(.link-preview-video) {
    display: block;
    width: 100%;
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

  .compact .link-preview-text {
    flex: 1;
    min-width: 0;
  }

  .link-preview-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .link-preview-author {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
