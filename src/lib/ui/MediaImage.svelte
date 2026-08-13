<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { SvelteMap } from 'svelte/reactivity';

  const mediaUrls = new SvelteMap<string, string>();
  const pendingMedia = new SvelteMap<string, Promise<string>>();

  interface Props {
    source: string;
    alt: string;
    width: number;
    height: number;
    class?: string;
  }

  let { source, alt, width, height, class: className = '' }: Props = $props();
  const core = useCoreClient();
  let url = $state<string | null>(null);

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
      .catch(() => pendingMedia.delete(key));

    return () => {
      active = false;
    };
  });
</script>

{#if url}
  <img class={className} src={url} {alt} />
{/if}
