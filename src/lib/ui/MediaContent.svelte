<script lang="ts">
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { saveFile, savesNatively } from '#lib/platform/files.js';
  import { blurhashDataUrl } from '#lib/ui/blurhash.js';
  import PdfThumbnail from '#lib/ui/PdfThumbnail.svelte';
  import { isPdfAttachment } from '#lib/ui/pdf-attachment.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl, retryMediaUrl } from '#lib/ui/media-url.js';
  import { mimeExtension } from '#lib/ui/mime-extension.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextAttachmentViewer from '#lib/ui/TextAttachmentViewer.svelte';
  import { videoStreamingSupported, videoStreamUrl } from '#lib/ui/video-stream.js';
  import { canPlayVideo } from '#lib/ui/video-support.js';
  import {
    MAX_TEXT_ATTACHMENT_BYTES,
    isTextAttachment,
    textAttachmentLanguage,
  } from '#lib/ui/text-attachment.js';
  import VoiceMessagePlayer from '#lib/ui/VoiceMessagePlayer.svelte';

  const BLURHASH_POSTER_WIDTH = 32;

  interface Props {
    source: string;
    mime: string | null;
    filename: string;
    kind: 'audio' | 'video' | 'file';
    width?: number | null;
    height?: number | null;
    size?: number | null;
    blurhash?: string | null;
    durationMs?: number | null;
    waveform?: number[] | null;
    onOpen?: () => void;
    class?: string;
  }

  let {
    source,
    mime,
    filename,
    kind,
    onOpen,
    width = null,
    height = null,
    size = null,
    blurhash = null,
    durationMs = null,
    waveform = null,
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
  let mediaLabel = $derived(
    filename ||
      (kind === 'video'
        ? $i18n.t('timeline.videoAttachment')
        : kind === 'audio'
          ? $i18n.t('timeline.audioAttachment')
          : $i18n.t('timeline.fileAttachment'))
  );
  /* Unlatches where no re-encoder answers, so a pessimistic `canPlayType`
     cannot strand the attachment. */
  let streamUnavailable = $state(false);
  let transcode = $derived(
    kind === 'video' && !canPlayVideo(mime) && !streamUnavailable && videoStreamingSupported(core)
  );
  /* Keyed by source: a recycled tile must not inherit another's start. */
  let startedSource = $state<string | null>(null);
  let started = $derived(startedSource === source);
  let awaitingPlay = $derived(transcode && !started);
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
  let isPdf = $derived(kind === 'file' && isPdfAttachment(mime, filename));
  let isText = $derived(
    kind === 'file' &&
      !isPdf &&
      (size === null || size <= MAX_TEXT_ATTACHMENT_BYTES) &&
      isTextAttachment(mime, filename)
  );
  let textLanguage = $derived(isText ? textAttachmentLanguage(mime, filename) : null);
  let extension = $derived(mimeExtension(mime));
  let sizeLabel = $derived(size !== null ? formatByteSize(size) : null);
  let retryWait = $derived(Math.max(0, retryAt - clock));
  let retryLabel = $derived(
    retryWait === 0
      ? $i18n.t('timeline.retryMedia')
      : $i18n.t('timeline.retryMediaIn', { count: Math.ceil(retryWait / 1000) })
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
    if (source !== backoffSource) {
      backoffSource = source;
      retryCount = 0;
      retryAt = 0;
    }
    if (transcode) {
      url = null;
      if (!started) {
        return () => {
          active = false;
        };
      }
      void videoStreamUrl(core, source)
        .then((streamUrl) => {
          if (active) url = streamUrl;
        })
        .catch(() => {
          if (active) streamUnavailable = true;
        });
      return () => {
        active = false;
      };
    }

    const release = holdMediaUrl(core, source, 0, 0);
    const cached = cachedMediaUrl(core, source, 0, 0);
    if (cached !== undefined) {
      url = cached;
      return release;
    }

    url = null;
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
          retryAt = Date.now() + Math.min(2 ** retryCount * 1000, 30_000);
          clock = Date.now();
        }
      });
    return () => {
      active = false;
      release();
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
  style:--media-ratio={aspectRatio}
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
        autoplay={started}
        src={url}
        poster={posterUrl}
        width={width ?? undefined}
        height={height ?? undefined}
        style:aspect-ratio={aspectRatio}
        aria-label={mediaLabel}
      >
        {filename}
      </video>
    {:else if kind === 'audio' && waveform !== null && waveform.length > 0}
      <VoiceMessagePlayer {url} body={filename} {durationMs} {waveform} />
    {:else if kind === 'audio'}
      <audio class="media-content" controls src={url} aria-label={mediaLabel}>
        {filename}
      </audio>
    {:else}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an object URL for the media bytes, not a route -->
      <a class="media-file" href={url} download={mediaLabel} onclick={download}>
        {#if extension}<span class="media-file-ext">{extension}</span>{/if}
        <span class="media-file-name">{mediaLabel}</span>
        {#if sizeLabel}<span class="media-file-size">{sizeLabel}</span>{/if}
      </a>
      {#if isPdf}
        <PdfThumbnail src={url} name={mediaLabel} {onOpen} />
      {:else if isText}
        <TextAttachmentViewer
          src={url}
          name={mediaLabel}
          language={textLanguage}
          onDownload={download}
        />
      {/if}
      <div class="media-actions">
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an object URL for the media bytes, not a route -->
        <LinkButton
          class="media-download"
          href={url}
          download={mediaLabel}
          size="small"
          onclick={download}
        >
          <DownloadSimpleIcon aria-hidden="true" />
          {sizeLabel
            ? $i18n.t('timeline.downloadFileSized', { size: sizeLabel })
            : $i18n.t('timeline.downloadFile')}
        </LinkButton>
      </div>
    {/if}
  {:else if kind === 'file'}
    <span class="media-file">
      {#if extension}<span class="media-file-ext">{extension}</span>{/if}
      <span class="media-file-name">{mediaLabel}</span>
      {#if sizeLabel}<span class="media-file-size">{sizeLabel}</span>{/if}
    </span>
  {/if}
  {#if awaitingPlay && !failed}
    <button
      type="button"
      class="media-play"
      onclick={() => {
        startedSource = source;
      }}
      aria-label={$i18n.t('timeline.playVideo', { name: mediaLabel })}
    >
      {#if posterUrl}
        <img class="media-loading-poster" src={posterUrl} alt="" aria-hidden="true" />
      {/if}
      <span class="media-play-badge" aria-hidden="true">
        <PlayIcon weight="fill" />
      </span>
    </button>
  {:else if !failed && !url}
    <span class="media-loading">
      {#if posterUrl}
        <img class="media-loading-poster" src={posterUrl} alt="" aria-hidden="true" />
      {/if}
      <span class="media-loading-status">
        <Spinner small />
        {#if transcode}
          <span class="media-loading-label">{$i18n.t('timeline.videoConverting')}</span>
        {/if}
      </span>
    </span>
  {/if}
</div>

<style>
  .media-frame {
    display: block;
    max-width: 100%;
    position: relative;
  }

  .media-loading {
    align-items: center;
    display: flex;
    inset: 0;
    justify-content: center;
    position: absolute;
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
    color: var(--surface-var-on-container);
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
    color: var(--surface-var-on-container);
    display: flex;
    height: var(--control-height-medium);
    justify-content: center;
    position: relative;
    width: var(--control-height-medium);
  }

  .media-frame-video {
    background: var(--surface-container);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .media-frame-audio {
    min-height: var(--control-height-medium);
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

  .media-file {
    align-items: center;
    color: var(--primary-main);
    display: inline-flex;
    gap: var(--space-100);
    margin-top: var(--space-100);
    max-width: 100%;
  }

  .media-file-ext {
    background: var(--surface-container);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    flex: none;
    font-size: var(--font-size-small);
    padding: var(--space-050) var(--space-100);
    text-transform: uppercase;
  }

  .media-file-name {
    overflow-wrap: anywhere;
  }

  .media-file-size {
    color: var(--surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
  }

  .media-actions {
    margin-top: var(--space-200);
  }

  .media-error {
    color: var(--crit-on-container);
    display: inline-block;
    margin-top: var(--space-100);
  }

  .retry-media {
    margin-left: var(--space-300);
  }
</style>
