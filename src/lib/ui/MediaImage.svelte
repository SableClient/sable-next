<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { cachedMediaUrl, loadMediaUrl } from '$lib/ui/media-url';

  interface Props {
    source: string;
    alt: string;
    width: number;
    height: number;
    intrinsicWidth?: number | null;
    intrinsicHeight?: number | null;
    mime?: string | null;
    class?: string;
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
  }: Props = $props();
  const core = useCoreClient();
  let url = $state<string | null>(null);
  /* Tagged with the url, not the source prop that `load` can outlive: the
     virtualiser recycles this node into another message, and a stale ratio
     would size that one. */
  let decoded = $state.raw<{ url: string; ratio: number } | null>(null);
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
  /* The event's own dimensions win even if the served file disagrees: the
     timeline sizes its rows from them, so revising the box after load would
     shift everything below it. Only a dimensionless event waits for the file. */
  let aspectRatio = $derived(eventRatio ?? (decoded?.url === url ? decoded.ratio : width / height));

  function onload(event: Event): void {
    const image = event.currentTarget;
    if (!(image instanceof HTMLImageElement) || image.naturalHeight === 0) return;
    decoded = { url: image.src, ratio: image.naturalWidth / image.naturalHeight };
  }

  $effect(() => {
    let active = true;
    const original = mime === 'image/svg+xml';
    const requestWidth = original ? 0 : width;
    const requestHeight = original ? 0 : height;
    const cached = cachedMediaUrl(source, requestWidth, requestHeight);
    if (cached !== undefined) {
      url = cached;
      return;
    }

    url = null;
    void loadMediaUrl(core, source, requestWidth, requestHeight, mime)
      .then((nextUrl) => {
        if (!active) return;
        url = nextUrl;
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  });
</script>

<span class={[className, 'media-image']} style:--media-ratio={aspectRatio}>
  {#if url}
    <img class="media-image-content" src={url} {alt} {onload} />
  {/if}
</span>

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
</style>
