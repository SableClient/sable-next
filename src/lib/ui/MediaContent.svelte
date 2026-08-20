<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { saveFile, savesNatively } from '#lib/platform/files.js';
  import { cachedMediaUrl, loadMediaUrl, retryMediaUrl } from '#lib/ui/media-url.js';
  import Button from '#lib/ui/primitives/Button.svelte';

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
  let retryCount = $state(0);
  let retryAt = $state(0);
  let clock = $state(Date.now());
  let loadGeneration = $state(0);
  let retryNextLoad = false;
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

  function download(event: MouseEvent): void {
    if (url === null || !savesNatively()) return;
    event.preventDefault();
    void saveFile(url, mediaLabel);
  }

  $effect(() => {
    let active = true;
    const retry = loadGeneration > 0 && retryNextLoad;
    retryNextLoad = false;
    failed = false;
    const cached = cachedMediaUrl(source, 0, 0);
    if (cached !== undefined) {
      url = cached;
      return;
    }

    url = null;
    const load = retry ? retryMediaUrl : loadMediaUrl;
    void load(core, source, 0, 0, mime)
      .then((nextUrl) => {
        if (active) url = nextUrl;
      })
      .catch(() => {
        if (!active) return;
        failed = true;
        if (retryCount > 0) {
          retryAt = Date.now() + Math.min(2 ** retryCount * 1000, 30_000);
          clock = Date.now();
        }
      });
    return () => {
      active = false;
    };
  });

  function retry(): void {
    if (retryWait > 0) return;
    retryCount += 1;
    retryAt = 0;
    failed = false;
    retryNextLoad = true;
    loadGeneration += 1;
  }
</script>

<div
  class={['media-frame', `media-frame-${kind}`, className]}
  style:aspect-ratio={aspectRatio}
  aria-busy={!url && !failed ? 'true' : undefined}
>
  {#if failed}
    <span class="media-error">
      {mediaLabel}: {$i18n.t('timeline.mediaUnavailable')}
      <Button class="retry-media" size="small" onclick={retry} disabled={retryWait > 0}>
        {retryLabel}
      </Button>
    </span>
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
    height: 100%;
    margin-top: 0;
    object-fit: contain;
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

  .retry-media {
    margin-left: var(--space-2);
  }
</style>
