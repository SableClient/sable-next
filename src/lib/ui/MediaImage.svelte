<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import {
    cachedMediaUrl,
    loadMediaUrl,
    mediaAspectRatio,
    retryMediaUrl,
  } from '#lib/ui/media-url.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ImageBrokenIcon from 'phosphor-svelte/lib/ImageBrokenIcon';

  interface Props {
    source: string;
    alt: string;
    width: number;
    height: number;
    intrinsicWidth?: number | null;
    intrinsicHeight?: number | null;
    mime?: string | null;
    class?: string;
    onclick?: () => void;
    onfailed?: () => void;
    retryable?: boolean;
  }

  let {
    source,
    alt,
    width,
    height,
    intrinsicWidth = null,
    intrinsicHeight = null,
    mime = null,
    class: className = '',
    onclick,
    onfailed,
    retryable = false,
  }: Props = $props();
  const core = useCoreClient();
  let url = $state<string | null>(null);
  let failed = $state(false);
  let retryCount = $state(0);
  let retryAt = $state(0);
  let clock = $state(Date.now());
  let loadGeneration = $state(0);
  let retryNextLoad = false;
  let fileRatio = $state<number | null>(null);
  let eventRatio = $derived.by(() => {
    const hasIntrinsicSize =
      intrinsicWidth !== null &&
      intrinsicHeight !== null &&
      Number.isFinite(intrinsicWidth) &&
      Number.isFinite(intrinsicHeight) &&
      intrinsicWidth > 0 &&
      intrinsicHeight > 0;
    return hasIntrinsicSize ? intrinsicWidth / intrinsicHeight : null;
  });
  /* The event's dimensions reserve the row and are never revised: the served file
     is a thumbnail whose shape need not match. The decoded shape covers an event
     carrying none, and is known before the `<img>` mounts. */
  let aspectRatio = $derived(eventRatio ?? fileRatio ?? width / height);
  let unavailableLabel = $derived(
    alt ? `${alt}: ${$i18n.t('timeline.mediaUnavailable')}` : $i18n.t('timeline.mediaUnavailable')
  );
  let retryWait = $derived(Math.max(0, retryAt - clock));
  let retryLabel = $derived(
    retryWait === 0
      ? $i18n.t('timeline.retryMedia')
      : $i18n.t('timeline.retryMediaIn', { count: Math.ceil(retryWait / 1000) })
  );

  $effect(() => {
    if (!failed || retryWait === 0) return;
    const timeout = setTimeout(() => {
      clock = Date.now();
    }, retryWait);
    return () => {
      clearTimeout(timeout);
    };
  });

  $effect(() => {
    let active = true;
    const retry = loadGeneration > 0 && retryNextLoad;
    retryNextLoad = false;
    const original = mime === 'image/svg+xml';
    const requestWidth = original ? 0 : width;
    const requestHeight = original ? 0 : height;
    const cached = cachedMediaUrl(source, requestWidth, requestHeight);
    if (cached !== undefined) {
      fileRatio = mediaAspectRatio(source);
      url = cached;
      return;
    }

    url = null;
    failed = false;
    fileRatio = null;
    const load = retry ? retryMediaUrl : loadMediaUrl;
    void load(core, source, requestWidth, requestHeight, mime)
      .then((nextUrl) => {
        if (!active) return;
        fileRatio = mediaAspectRatio(source);
        url = nextUrl;
      })
      .catch(() => {
        if (!active) return;
        failed = true;
        if (retryable && retryCount > 0) {
          retryAt = Date.now() + Math.min(2 ** retryCount * 1000, 30_000);
          clock = Date.now();
        }
        onfailed?.();
      });

    return () => {
      active = false;
    };
  });

  function stopTimelinePress(event: PointerEvent): void {
    event.stopPropagation();
  }

  function retry(event: MouseEvent): void {
    event.stopPropagation();
    if (retryWait > 0) return;
    retryCount += 1;
    retryAt = 0;
    failed = false;
    retryNextLoad = true;
    loadGeneration += 1;
  }
</script>

{#snippet content()}
  {#if url}
    <img class="media-image-content" src={url} {alt} />
  {:else if failed}
    <span class="media-image-unavailable">
      <ImageBrokenIcon />
      <span>{unavailableLabel}</span>
      {#if retryable}
        <Button class="retry-media" size="small" onclick={retry} disabled={retryWait > 0}>
          {retryLabel}
        </Button>
      {/if}
    </span>
  {/if}
{/snippet}

{#if onclick && !failed}
  <button
    class={[className, 'media-image', 'interactive']}
    style:--media-ratio={aspectRatio}
    type="button"
    aria-label={`Open ${alt || 'media'}`}
    {onclick}
    onpointerdown={stopTimelinePress}
    onpointermove={stopTimelinePress}
    onpointerup={stopTimelinePress}
  >
    <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
    {@render content()}
  </button>
{:else}
  <span class={[className, 'media-image']} style:--media-ratio={aspectRatio}>
    <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
    {@render content()}
  </span>
{/if}

<style>
  .media-image {
    aspect-ratio: var(--media-ratio);
    display: block;
    overflow: hidden;
  }

  .media-image-content {
    display: block;
    height: 100%;
    object-fit: contain;
    object-position: left top;
    width: 100%;
  }

  .media-image-unavailable {
    align-items: center;
    background: var(--sable-surface-container);
    color: var(--sable-surface-on-container);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-small);
    gap: 0.25rem;
    height: 100%;
    justify-content: center;
    padding: 0.5rem;
    text-align: center;
  }

  .media-image-unavailable :global(svg) {
    flex: none;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .media-image.interactive {
    background: none;
    border: 0;
    cursor: zoom-in;
    padding: 0;
    text-align: left;
  }

  .media-image.interactive:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 0.2rem;
  }

  .retry-media {
    margin-top: 0.25rem;
  }
</style>
