<script lang="ts">
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import type { VideoPlaybackView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { i18n } from '#lib/i18n.js';
  import { savesNatively } from '#lib/platform/files.js';
  import { blurhashDataUrl } from '#lib/ui/blurhash.js';
  import { downloadUrl } from '#lib/ui/download.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl, retryMediaUrl } from '#lib/ui/media-url.js';
  import { mediaProgress } from '#lib/ui/media-progress.svelte.js';
  import { mediaRetryDelay } from '#lib/ui/media-retry.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { animationsPaused } from '#lib/ui/still-frame.js';
  import { videoPlayback } from '#lib/ui/video-playback.js';
  import '#lib/ui/media-size.css';

  const BLURHASH_POSTER_WIDTH = 32;

  interface Props {
    source: string;
    mime: string | null;
    filename: string;
    width?: number | null;
    height?: number | null;
    blurhash?: string | null;
    thumbnail?: string | null;
    thumbnailMime?: string | null;
    playback?: VideoPlaybackView | null;
    size?: number | null;
    class?: string;
  }

  let {
    source,
    mime,
    filename,
    width = null,
    height = null,
    blurhash = null,
    thumbnail = null,
    thumbnailMime = null,
    playback = null,
    size = null,
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
  let backoffSource: string | null = null;
  /* An unsized video lays out at the UA's 150px, then jumps to its intrinsic
     size once metadata arrives, shoving the rows below it down. */
  let mediaLabel = $derived(filename || i18n.t('timeline.videoAttachment'));
  /* Keyed by source: a recycled tile must not inherit another's start. */
  let startedSource = $state<string | null>(null);
  let video = $derived(videoPlayback(playback));
  let started = $derived(startedSource === source || video.autoplay);
  let awaitingPlay = $derived(!started && url === null);
  let posterFailed = $state<string | null>(null);
  let videoElement = $state<HTMLVideoElement>();
  let heldForFocus = false;

  $effect(() => {
    if (!videoElement || !video.autoplay) return;
    if (animationsPaused()) {
      if (videoElement.paused) return;
      videoElement.pause();
      heldForFocus = true;
    } else if (heldForFocus) {
      heldForFocus = false;
      void videoElement.play().catch(() => {});
    }
  });
  let unsupportedUrl = $state<string | null>(null);
  let aspectRatio = $derived(
    typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
      ? `${String(width)} / ${String(height)}`
      : '16 / 9'
  );
  let posterUrl = $derived.by(() => {
    if (blurhash === null) return undefined;
    const ratio =
      typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
        ? width / height
        : 16 / 9;
    const posterHeight = Math.max(1, Math.round(BLURHASH_POSTER_WIDTH / ratio));
    try {
      return blurhashDataUrl(blurhash, BLURHASH_POSTER_WIDTH, posterHeight) ?? undefined;
    } catch (error) {
      console.debug('[sable media] the blurhash poster could not be decoded', error);
      return undefined;
    }
  });
  let retryWait = $derived(Math.max(0, retryAt - clock));
  const loading = mediaProgress(core, () => (!url && !failed ? source : null));
  let retryLabel = $derived(
    retryWait === 0
      ? i18n.t('common.retry')
      : i18n.t('timeline.retryMediaIn', { count: Math.ceil(retryWait / 1000) })
  );

  $effect(() => {
    if (!failed || retryWait === 0) return;
    const timeout = setTimeout(
      () => {
        clock = Date.now();
      },
      Math.min(retryWait, 1000)
    );
    return () => {
      clearTimeout(timeout);
    };
  });

  $effect(() => {
    let active = true;
    const retry = loadGeneration > 0 && retryNextLoad;
    retryNextLoad = false;
    failed = false;
    if (source !== backoffSource) {
      backoffSource = source;
      retryCount = 0;
      retryAt = 0;
    }
    const release = holdMediaUrl(core, source, 0, 0);
    const cached = cachedMediaUrl(core, source, 0, 0);
    if (cached !== undefined) {
      url = cached;
      return release;
    }

    url = null;
    if (!started) return release;
    const load = retry ? retryMediaUrl : loadMediaUrl;
    void load(core, source, 0, 0, mime)
      .then((nextUrl) => {
        if (!active) return;
        url = nextUrl;
        retryCount = 0;
        retryAt = 0;
      })
      .catch(() => {
        if (!active) return;
        failed = true;
        if (retryCount > 0) {
          retryAt = Date.now() + mediaRetryDelay(retryCount);
          clock = Date.now();
        }
      });
    return () => {
      active = false;
      release();
    };
  });

  function download(event: MouseEvent): void {
    if (url === null || !savesNatively()) return;
    event.preventDefault();
    void downloadUrl(url, mediaLabel);
  }

  function play(): void {
    startedSource = source;
  }

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
  class={['media-frame', `media-frame-video`, className]}
  style:aspect-ratio={aspectRatio}
  style:--media-ratio={aspectRatio}
  aria-busy={!url && !failed ? 'true' : undefined}
>
  {#if failed}
    <span class="media-error">
      {mediaLabel}: {i18n.t('timeline.mediaUnavailable')}
      <Button class="retry-media" size="small" onclick={retry} disabled={retryWait > 0}>
        {retryLabel}
      </Button>
    </span>
  {:else if url && unsupportedUrl === url}
    <span class="media-unsupported">
      {i18n.t('timeline.videoUnsupported')}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an object URL for the media bytes, not a route -->
      <LinkButton href={url} download={mediaLabel} size="small" onclick={download}>
        <DownloadSimpleIcon aria-hidden="true" />
        {i18n.t('common.download')}
      </LinkButton>
    </span>
  {:else if url}
    <video
      bind:this={videoElement}
      class="media-content media-video"
      controls={video.controls}
      controlslist={savesNatively() ? 'nodownload' : undefined}
      autoplay={started}
      loop={video.loop}
      muted={video.muted}
      playsinline
      src={url}
      poster={posterUrl}
      width={width ?? undefined}
      height={height ?? undefined}
      style:aspect-ratio={aspectRatio}
      aria-label={mediaLabel}
      onerror={() => {
        unsupportedUrl = url;
      }}
    >
      {filename}
    </video>
  {:else}
    {#if thumbnail && posterFailed !== thumbnail}
      <MediaImage
        class="media-poster"
        source={thumbnail}
        mime={thumbnailMime}
        alt=""
        width={800}
        height={600}
        intrinsicWidth={width}
        intrinsicHeight={height}
        {blurhash}
        onfailed={(source) => {
          posterFailed = source;
        }}
      />
    {:else if posterUrl}
      <img class="media-loading-poster" src={posterUrl} alt="" aria-hidden="true" />
    {/if}
  {/if}
  {#if awaitingPlay && !failed}
    <button
      type="button"
      class="media-play"
      onclick={play}
      aria-label={i18n.t('timeline.playVideo', { name: mediaLabel })}
    >
      <span class="media-play-badge" aria-hidden="true">
        <PlayIcon weight="fill" />
      </span>
    </button>
    {#if size !== null && size > 0}<span class="media-image-size">{formatByteSize(size)}</span>{/if}
  {:else if !failed && !url && !!started}
    <span class="media-loading">
      <span class="media-loading-status">
        <Spinner small />
        {#if loading.percent !== null}
          <span class="media-loading-label">
            {i18n.t('timeline.downloadProgress', { percent: loading.percent })}
          </span>
        {/if}
      </span>
    </span>
  {/if}
</div>

<style>
  .media-frame {
    background-color: var(--surface-var-container);
    border-radius: var(--radius);
    display: block;
    max-width: 100%;
    overflow: hidden;
    position: relative;
  }

  .media-loading {
    align-items: center;
    display: flex;
    inset: 0;
    justify-content: center;
    position: absolute;
  }

  .media-frame :global(.media-poster) {
    height: 100%;
    inset: 0;
    position: absolute;
    width: 100%;
  }

  .media-loading-poster {
    filter: blur(var(--blur-small));
    height: 100%;
    inset: 0;
    object-fit: cover;
    position: absolute;
    width: 100%;
  }

  .media-loading-status {
    align-items: center;
    background: var(--surface-container);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: flex;
    gap: var(--space-100);
    padding: var(--space-100) var(--space-200);
    position: relative;
  }

  .media-loading-label {
    font-size: var(--font-size-small);
  }

  .media-play {
    align-items: center;
    background: none;
    border: 0;
    cursor: pointer;
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 0;
    position: absolute;
    width: 100%;
  }

  .media-play-badge {
    align-items: center;
    background: var(--surface-container);
    border-radius: 50%;
    color: var(--surface-on-container);
    display: flex;
    height: var(--control-height-medium);
    justify-content: center;
    position: relative;
    width: var(--control-height-medium);
  }

  .media-content {
    display: block;
    margin-top: var(--space-100);
    max-width: 100%;
    width: 100%;
  }

  /* Fallback for a dimensionless event; the timeline estimator assumes it. */
  .media-video {
    aspect-ratio: 16 / 9;
    background: var(--surface-var-container);
    border-radius: var(--radius);
    height: 100%;
    margin-top: 0;
    object-fit: contain;
    width: 100%;
  }

  .media-unsupported {
    align-items: center;
    color: var(--surface-on-container);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    inset: 0;
    justify-content: center;
    padding: var(--space-200);
    position: absolute;
    text-align: center;
  }

  .media-error {
    color: var(--crit-main);
    display: inline-block;
    margin-top: var(--space-100);
  }

  .retry-media {
    margin-left: var(--space-300);
  }
</style>
