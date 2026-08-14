<script lang="ts">
  import { cachedMediaUrl, loadMediaUrl } from '$lib/ui/media-url';
  import { useCoreClient } from '$lib/core/context';

  interface Props {
    source: string;
    mime: string | null;
    body: string;
    kind: 'audio' | 'video' | 'file';
    width?: number | null;
    height?: number | null;
    class?: string;
  }

  let {
    source,
    mime,
    body,
    kind,
    width = null,
    height = null,
    class: className = '',
  }: Props = $props();
  const core = useCoreClient();
  let url = $state<string | null>(null);
  let failed = $state(false);
  /* An unsized video lays out at the UA's 150px, then jumps to its intrinsic
     size once metadata arrives, shoving the rows below it down. */
  let aspectRatio = $derived(
    width !== null && height !== null && width > 0 && height > 0 ? width / height : null
  );

  $effect(() => {
    let active = true;
    failed = false;
    const cached = cachedMediaUrl(source, 0, 0);
    if (cached !== undefined) {
      url = cached;
      return;
    }

    url = null;
    void loadMediaUrl(core, source, 0, 0, mime)
      .then((nextUrl) => {
        if (active) url = nextUrl;
      })
      .catch(() => {
        if (active) failed = true;
      });
    return () => {
      active = false;
    };
  });
</script>

{#if failed}
  <span class={[className, 'media-error']}>{body}</span>
{:else if kind === 'video'}
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    class={[className, 'media-content', 'media-video']}
    style:aspect-ratio={aspectRatio}
    controls
    src={url}
  >
    {body}
  </video>
{:else if kind === 'audio'}
  <audio class={[className, 'media-content']} controls src={url}> {body} </audio>
{:else if url}
  <!-- Blob URLs are generated locally from authenticated media bytes. -->
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
  <a class={[className, 'media-file']} href={url} download={body}>{body}</a>
{:else}
  <span class={[className, 'media-file']}>{body}</span>
{/if}

<style>
  .media-content {
    display: block;
    margin-top: 0.25rem;
    max-width: 100%;
  }

  /* Fallback for a dimensionless event; the timeline estimator assumes it. */
  .media-video {
    aspect-ratio: 16 / 9;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    width: 100%;
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
