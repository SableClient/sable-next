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
  let aspectRatio = $derived.by(() => {
    const hasIntrinsicSize =
      intrinsicWidth !== null &&
      intrinsicHeight !== null &&
      Number.isFinite(intrinsicWidth) &&
      Number.isFinite(intrinsicHeight) &&
      intrinsicWidth > 0 &&
      intrinsicHeight > 0;
    return hasIntrinsicSize
      ? `${String(intrinsicWidth)} / ${String(intrinsicHeight)}`
      : `${String(width)} / ${String(height)}`;
  });

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

<span class={[className, 'media-image']} style:aspect-ratio={aspectRatio}>
  {#if url}
    <img class="media-image-content" src={url} {alt} />
  {/if}
</span>

<style>
  .media-image {
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
