<script lang="ts">
  import { useCoreClient } from '$lib/core/context';

  interface Props {
    source: string;
    mime: string | null;
    body: string;
    kind: 'audio' | 'video' | 'file';
    class?: string;
  }

  let { source, mime, body, kind, class: className = '' }: Props = $props();
  const core = useCoreClient();
  let url = $state<string | null>(null);
  let failed = $state(false);

  $effect(() => {
    let active = true;
    let objectUrl: string | undefined;
    url = null;
    failed = false;
    void core
      .fetchMedia(source, 0, 0)
      .then((bytes) => {
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime ?? '' }));
        if (active) url = objectUrl;
      })
      .catch(() => {
        if (active) failed = true;
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

{#if url}
  {#if kind === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class={[className, 'media-content']} controls src={url}> {body} </video>
  {:else if kind === 'audio'}
    <audio class={[className, 'media-content']} controls src={url}> {body} </audio>
  {:else}
    <!-- Blob URLs are generated locally from authenticated media bytes. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a class={[className, 'media-file']} href={url} download={body}>{body}</a>
  {/if}
{:else if kind === 'file'}
  <span class={[className, 'media-file']}>{body}</span>
{:else if failed}
  <span class={[className, 'media-error']}>{body}</span>
{/if}

<style>
  .media-content {
    display: block;
    margin-top: 0.25rem;
    max-width: 100%;
  }

  .media-file {
    color: var(--sable-primary-main);
    display: inline-block;
    margin-top: 0.25rem;
    overflow-wrap: anywhere;
  }

  .media-error {
    color: var(--sable-crit-on-container);
    display: inline-block;
    margin-top: 0.25rem;
  }
</style>
