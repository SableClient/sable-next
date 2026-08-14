<script module lang="ts">
  import { SvelteMap } from 'svelte/reactivity';

  const mediaUrls = new SvelteMap<string, string>();
  const pendingMedia = new SvelteMap<string, Promise<string>>();
</script>

<script lang="ts">
  import { useCoreClient } from '$lib/core/context';

  interface Props {
    source: string;
    alt: string;
    width: number;
    height: number;
    intrinsicWidth?: number | null;
    intrinsicHeight?: number | null;
    class?: string;
  }

  let {
    source,
    alt,
    width,
    height,
    intrinsicWidth = null,
    intrinsicHeight = null,
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
    const key = `${source}:${String(width)}:${String(height)}`;
    const cached = mediaUrls.get(key);
    if (cached) {
      url = cached;
      return;
    }

    const pending =
      pendingMedia.get(key) ??
      core.fetchMedia(source, width, height).then((bytes) => {
        const objectUrl = URL.createObjectURL(new Blob([bytes]));
        mediaUrls.set(key, objectUrl);
        pendingMedia.delete(key);
        return objectUrl;
      });
    pendingMedia.set(key, pending);

    void pending
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
    width: 100%;
  }
</style>
