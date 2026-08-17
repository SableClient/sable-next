<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { cachedMediaUrl, loadMediaUrl, mediaAspectRatio } from '$lib/ui/media-url';

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

  $effect(() => {
    let active = true;
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
    fileRatio = null;
    void loadMediaUrl(core, source, requestWidth, requestHeight, mime)
      .then((nextUrl) => {
        if (!active) return;
        fileRatio = mediaAspectRatio(source);
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
    <img class="media-image-content" src={url} {alt} />
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
