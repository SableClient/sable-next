<script lang="ts">
  import { useCoreClient } from '$lib/core/context';

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
    let objectUrl: string | null = null;
    url = null;

    void core
      .fetchMedia(source, width, height)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        url = objectUrl;
      })
      .catch(() => {});

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

{#if url}
  <img class={className} src={url} {alt} />
{/if}
