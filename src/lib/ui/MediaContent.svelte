<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { saveFile, savesNatively } from '$lib/platform/files';
  import { cachedMediaUrl, loadMediaUrl } from '$lib/ui/media-url';

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
  let mediaLabel = $derived(
    body ||
      (kind === 'video'
        ? $i18n.t('timeline.videoAttachment')
        : kind === 'audio'
          ? $i18n.t('timeline.audioAttachment')
          : $i18n.t('timeline.fileAttachment'))
  );
  let aspectRatio = $derived(
    kind === 'video' &&
      typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
      ? `${String(width)} / ${String(height)}`
      : kind === 'video'
        ? '16 / 9'
        : undefined
  );

  function download(event: MouseEvent): void {
    if (url === null || !savesNatively()) return;
    event.preventDefault();
    void saveFile(url, mediaLabel);
  }

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

<div
  class={['media-frame', `media-frame-${kind}`, className]}
  style:aspect-ratio={aspectRatio}
  aria-busy={!url && !failed ? 'true' : undefined}
>
  {#if failed}
    <span class="media-error">{mediaLabel}</span>
  {:else if url}
    {#if kind === 'video'}
      <!-- Matrix carries no caption track for an attachment. -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        class="media-content media-video"
        controls
        src={url}
        width={width ?? undefined}
        height={height ?? undefined}
        style:aspect-ratio={aspectRatio}
        aria-label={mediaLabel}
      >
        {body}
      </video>
    {:else if kind === 'audio'}
      <audio class="media-content" controls src={url} aria-label={mediaLabel}>
        {body}
      </audio>
    {:else}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an object URL for the media bytes, not a route -->
      <a class="media-file" href={url} download={mediaLabel} onclick={download}>{mediaLabel}</a>
    {/if}
  {:else if kind === 'file'}
    <span class="media-file">{mediaLabel}</span>
  {/if}
</div>

<style>
  .media-frame {
    display: block;
    max-width: 100%;
  }

  .media-frame-video {
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .media-frame-audio {
    min-height: var(--control-height-medium);
  }

  .media-content {
    display: block;
    margin-top: 0.25rem;
    max-width: 100%;
    width: 100%;
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
