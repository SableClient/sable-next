<script lang="ts">
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';

  import type { AudioMetadataView, VideoPlaybackView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { savesNatively } from '#lib/platform/files.js';
  import AudioTrack from '#lib/ui/AudioTrack.svelte';
  import PdfThumbnail from '#lib/ui/PdfThumbnail.svelte';
  import { isPdfAttachment } from '#lib/ui/pdf-attachment.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl, retryMediaUrl } from '#lib/ui/media-url.js';
  import { mediaProgress } from '#lib/ui/media-progress.svelte.js';
  import { mediaRetryDelay } from '#lib/ui/media-retry.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';
  import TextAttachmentViewer from '#lib/ui/TextAttachmentViewer.svelte';
  import ThemeFileCard from '#lib/ui/ThemeFileCard.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { isThemeFileName, MAX_THEME_FILE_BYTES } from '#lib/settings/theme-file.js';
  import { downloadUrl } from '#lib/ui/download.js';
  import {
    MAX_TEXT_ATTACHMENT_BYTES,
    isTextAttachment,
    textAttachmentLanguage,
  } from '#lib/ui/text-attachment.js';
  import VoiceMessagePlayer from '#lib/ui/VoiceMessagePlayer.svelte';
  import AudioPlayer from './AudioPlayer.svelte';
  import VideoPlayer from './VideoPlayer.svelte';

  interface Props {
    source: string;
    mime: string | null;
    filename: string;
    kind: 'audio' | 'video' | 'file';
    width?: number | null;
    height?: number | null;
    size?: number | null;
    blurhash?: string | null;
    thumbnail?: string | null;
    thumbnailMime?: string | null;
    durationMs?: number | null;
    waveform?: number[] | null;
    audioMetadata?: AudioMetadataView | null;
    playback?: VideoPlaybackView | null;
    onOpen?: () => void;
    class?: string;
  }

  let {
    source,
    mime,
    filename,
    kind: declaredKind,
    onOpen,
    width = null,
    height = null,
    size = null,
    blurhash = null,
    thumbnail = null,
    thumbnailMime = null,
    durationMs = null,
    waveform = null,
    audioMetadata = null,
    playback = null,
    class: className = '',
  }: Props = $props();
  const core = useCoreClient();
  let kind = $derived(
    declaredKind === 'file' && mime?.toLowerCase().startsWith('audio/') ? 'audio' : declaredKind
  );
  let url = $state<string | null>(null);
  let failed = $state(false);
  let retryCount = $state(0);
  let retryAt = $state(0);
  let clock = $state(Date.now());
  let loadGeneration = $state(0);
  let retryNextLoad = false;
  let backoffSource: string | null = null;
  let mediaLabel = $derived(
    filename ||
      (kind === 'audio' ? i18n.t('timeline.audioAttachment') : i18n.t('timeline.fileAttachment'))
  );
  /* Keyed by source: a recycled tile must not inherit another's start. */
  let startedSource = $state<string | null>(null);
  let started = $derived(startedSource === source);
  let isPdf = $derived(kind === 'file' && isPdfAttachment(mime, filename));
  let isText = $derived(
    kind === 'file' &&
      !isPdf &&
      (size === null || size <= MAX_TEXT_ATTACHMENT_BYTES) &&
      isTextAttachment(mime, filename)
  );
  let textLanguage = $derived(isText ? textAttachmentLanguage(mime, filename) : null);
  let isThemeFile = $derived(
    preferences.themeFileCards &&
      isText &&
      (size === null || size <= MAX_THEME_FILE_BYTES) &&
      isThemeFileName(filename)
  );
  let deferred = $derived(kind === 'video' || (kind === 'file' && !isPdf && !isText));
  let sizeLabel = $derived(size !== null ? formatByteSize(size) : null);
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

  function download(event: MouseEvent): void {
    if (url === null || !savesNatively()) return;
    event.preventDefault();
    save(url);
  }

  function save(objectUrl: string): void {
    void downloadUrl(objectUrl, mediaLabel);
  }

  function fetchFile(): void {
    startedSource = source;
    void loadMediaUrl(core, source, 0, 0, mime).then(save, (error: unknown) => {
      console.warn('[sable media] the file could not be fetched', error);
    });
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

    const release = holdMediaUrl(core, source, 0, 0);
    const cached = cachedMediaUrl(core, source, 0, 0);
    if (cached !== undefined) {
      url = cached;
      return release;
    }

    url = null;
    if (deferred && !started) return release;
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

  $effect(() => {
    void source;
    return () => {};
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

{#if kind === 'video'}
  <VideoPlayer
    {source}
    {mime}
    {filename}
    {width}
    {height}
    {blurhash}
    {thumbnail}
    {thumbnailMime}
    {playback}
    {size}
    class={className}
  />
{:else}
  <div
    class={['media-frame', `media-frame-${kind}`, className]}
    aria-busy={!url && !failed ? 'true' : undefined}
  >
    {#if failed}
      <span class="media-error">
        {mediaLabel}: {i18n.t('timeline.mediaUnavailable')}
        <Button class="retry-media" size="small" onclick={retry} disabled={retryWait > 0}>
          {retryLabel}
        </Button>
      </span>
    {:else if url}
      {#if kind === 'audio' && waveform !== null && waveform.length > 0}
        <VoiceMessagePlayer {url} body={filename} {durationMs} {waveform} />
      {:else if kind === 'audio'}
        {#if audioMetadata}<AudioTrack metadata={audioMetadata} fallbackTitle={mediaLabel} />{/if}
        <AudioPlayer src={url} {filename} label={mediaLabel} attachedTop={audioMetadata !== null}
        ></AudioPlayer>
      {:else}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an object URL for the media bytes, not a route -->
        <span class="media-file">
          <FileIcon size={24} />
          <span class="media-file-name">{mediaLabel}</span>
          {#if sizeLabel}<span class="media-file-size">{sizeLabel}</span>{/if}
        </span>
        {#if isThemeFile}
          <ThemeFileCard src={url} name={filename} />
        {/if}
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
            {i18n.t('common.download')}
          </LinkButton>
        </div>
      {/if}
    {:else if kind === 'file'}
      <span class="media-file">
        <FileIcon size={24} />
        <span class="media-file-name">{mediaLabel}</span>
        {#if sizeLabel}<span class="media-file-size">{sizeLabel}</span>{/if}
      </span>
      {#if deferred && !started}
        <div class="media-actions">
          <Button class="media-download" size="small" onclick={fetchFile}>
            <DownloadSimpleIcon aria-hidden="true" />
            {i18n.t('common.download')}
          </Button>
        </div>
      {/if}
    {/if}
    {#if !failed && !url && !!started}
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
{/if}

<style>
  .media-frame {
    background-color: var(--surface-var-container);
    border-radius: var(--radius);
    display: block;
    max-width: 100%;
    padding: var(--space-250);
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

  .media-frame-audio {
    min-height: var(--control-height-medium);
  }

  .media-file {
    align-items: center;
    display: inline-flex;
    gap: var(--space-100);
    margin-top: var(--space-100);
    max-width: 100%;
  }

  .media-file-ext {
    background: var(--surface-container);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    flex: 0 1 auto;
    font-size: var(--font-size-small);
    max-width: 8em;
    overflow: hidden;
    padding: var(--space-050) var(--space-100);
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .media-file-name {
    font-size: var(--font-size-small);
    min-width: 0;
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
    color: var(--crit-main);
    display: inline-block;
    margin-top: var(--space-100);
  }

  .retry-media {
    margin-left: var(--space-300);
  }
</style>
