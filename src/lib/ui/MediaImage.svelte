<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { decodeBlurhashPixels } from '#lib/ui/blurhash.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { dominantColor } from '#lib/ui/dominant-color.js';
  import { DEFAULT_FRAME_MS, openGifPlayback, type GifPlayback } from '#lib/ui/gif-frames.js';
  import { mediaProgress } from '#lib/ui/media-progress.svelte.js';
  import { pixelatedImage } from '#lib/ui/pixelated.js';
  import { automaticMediaRetryDelay, mediaRetryDelay } from '#lib/ui/media-retry.js';
  import {
    cachedMediaType,
    cachedMediaUrl,
    discardMediaUrl,
    holdMediaUrl,
    isEncryptedMedia,
    loadMediaUrl,
    mediaAspectRatio,
    retryMediaUrl,
  } from '#lib/ui/media-url.js';
  import { animationsPaused, stillFrame } from '#lib/ui/still-frame.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import ImageBrokenIcon from 'phosphor-svelte/lib/ImageBrokenIcon';
  import ImageSpoilerControl from './ImageSpoilerControl.svelte';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  const BLURHASH_DECODE_WIDTH = 32;
  const ORIENTATION_TOLERANCE = 0.05;
  const ANIMATED_MIMES = ['image/gif', 'image/apng', 'image/avif', 'image/webp'];
  const ANIMATED_EXTENSIONS = ['.gif', '.apng', '.avif', '.webp'];

  interface Props {
    source: string;
    thumbnail?: string | null;
    alt: string;
    title?: string;
    width: number;
    height: number;
    intrinsicWidth?: number | null;
    intrinsicHeight?: number | null;
    mime?: string | null;
    animatedHint?: boolean | null;
    size?: number | null;
    blurhash?: string | null;
    class?: string;
    style?: string;
    onclick?: () => void;
    onloaded?: () => void;
    onfailed?: () => void;
    retryable?: boolean;
    uniform?: boolean;
    tint?: boolean;
    original?: boolean;
    autoplay?: boolean | null;
    spoilerReason?: string | null;
    href?: string;
    spoilerHidden?: boolean;
    spoilerName?: string;
  }

  let {
    source,
    thumbnail = null,
    alt,
    title,
    width,
    height,
    intrinsicWidth = null,
    intrinsicHeight = null,
    mime = null,
    animatedHint = null,
    size = null,
    blurhash = null,
    class: className = '',
    style,
    onclick,
    onloaded,
    onfailed,
    retryable = false,
    uniform = false,
    tint = false,
    original = false,
    autoplay = null,
    spoilerReason = null,
    href,
    spoilerHidden = $bindable(),
    spoilerName,
  }: Props = $props();
  const core = useCoreClient();
  let outcome = $state.raw<{ key: string; url: string | null; undecodable?: true } | null>(null);
  let backoff = $derived({ source, attempt: 0, forced: 0, manual: 0, automatic: 0, at: 0 });
  let attempt = $derived(backoff.attempt);
  let forced = $derived(backoff.forced);
  let clock = $state(Date.now());
  let gifPreview = $state<HTMLCanvasElement>();
  let gifImage = $state<HTMLImageElement>();
  let previewUrl = $state<string | null>(null);
  let playingUrl = $state<string | null>(null);
  let gifFrames = $state<GifPlayback | null>(null);
  /* Not `$state`: the loop would restart on every step if it tracked these. */
  let gifFrameIndex = 0;
  let gifFrameMs = DEFAULT_FRAME_MS;
  let paintedCanvas: HTMLCanvasElement | undefined;
  let paintedIndex = -1;
  let blurhashCanvas = $state<HTMLCanvasElement>();
  let loadedUrl = $state<string | null>(null);
  let imageElement = $state<HTMLImageElement>();
  let sidewaysSource = $state<string | null>(null);
  let undecodableThumbnail = $state<string | null>(null);
  let eventRatio = $derived.by(() => {
    const hasIntrinsicSize =
      intrinsicWidth !== null &&
      intrinsicHeight !== null &&
      Number.isFinite(intrinsicWidth) &&
      Number.isFinite(intrinsicHeight) &&
      intrinsicWidth > 0 &&
      intrinsicHeight > 0;
    return hasIntrinsicSize ? intrinsicWidth / intrinsicHeight : null;
  });
  let intrinsicCssWidth = $derived(
    eventRatio !== null && intrinsicWidth !== null ? `${String(intrinsicWidth)}px` : undefined
  );
  let animated = $derived(
    animatedHint ??
      (ANIMATED_MIMES.includes(mime ?? '') ||
        ANIMATED_EXTENSIONS.some((extension) => named(extension)))
  );
  let servedSideways = $derived(
    sidewaysSource === source || sideways(mediaAspectRatio(core, source, width, height))
  );
  let asIs = $derived(
    original ||
      mime === 'image/svg+xml' ||
      animated ||
      servedSideways ||
      undecodableThumbnail === source
  );
  let requested = $derived(
    thumbnail !== null &&
      isEncryptedMedia(source) &&
      !original &&
      !animated &&
      !servedSideways &&
      undecodableThumbnail !== source
      ? thumbnail
      : source
  );
  let requestedWidth = $derived(asIs ? 0 : width);
  let requestedHeight = $derived(asIs ? 0 : height);
  let requestKey = $derived(
    `${String(attempt)}:${String(requestedWidth)}x${String(requestedHeight)}:${requested}`
  );
  let url = $derived(
    outcome?.key === requestKey
      ? outcome.url
      : (cachedMediaUrl(core, requested, requestedWidth, requestedHeight) ?? null)
  );
  let failed = $derived(outcome?.key === requestKey && outcome.url === null);
  let undecodable = $derived(failed && outcome?.undecodable === true);
  let retryingFailure = $derived(
    outcome !== null &&
      outcome.url === null &&
      outcome.key.slice(outcome.key.indexOf(':')) === requestKey.slice(requestKey.indexOf(':'))
  );
  let showUnavailable = $derived(failed || retryingFailure);
  let fileRatio = $derived(
    url === null && !failed
      ? null
      : mediaAspectRatio(core, requested, requestedWidth, requestedHeight)
  );
  let imageLoaded = $derived(url !== null && loadedUrl === url);
  let naturalImage = $derived(
    imageLoaded && asIs && requested === source ? (imageElement ?? null) : null
  );
  let pixelated = $derived(
    pixelatedImage(
      preferences.pixelatedImages,
      intrinsicWidth ?? naturalImage?.naturalWidth,
      intrinsicHeight ?? naturalImage?.naturalHeight
    )
  );
  let gifPreviewReady = $derived(url !== null && previewUrl === url);
  let gifPlaying = $derived(url !== null && playingUrl === url);
  let plate = $derived.by(() => {
    if (!uniform || !preferences.uniformIcons || !imageLoaded) return null;
    const image = imageElement;
    if (!image?.complete) return null;
    return dominantColor(image);
  });
  let tinted = $derived(
    tint &&
      preferences.tintRoomIcons &&
      imageLoaded &&
      cachedMediaType(core, requested, requestedWidth, requestedHeight) === 'image/svg+xml'
  );
  let animatedGif = $derived(animatedHint !== false && (mime === 'image/gif' || named('.gif')));
  let manualGif = $derived(animatedGif && !(autoplay ?? preferences.autoplayGifs));
  let paused = $derived((animated || original) && animationsPaused());
  let heldFrame = $derived(paused && imageLoaded && imageElement ? stillFrame(imageElement) : null);
  let heldUrl = $derived(heldFrame ?? url);
  let steppedGif = $derived(gifFrames !== null);
  let heldGif = $derived(manualGif && !gifPlaying && gifPreviewReady);
  let painted = $derived(manualGif ? gifPreviewReady : imageLoaded);
  let showCanvas = $derived(manualGif && gifPreviewReady && (steppedGif || !gifPlaying));
  /* The event's dimensions reserve the row and are never revised: the served file
     is a thumbnail whose shape need not match. The decoded shape covers an event
     carrying none, and is known before the `<img>` mounts. */
  let aspectRatio = $derived(eventRatio ?? fileRatio ?? width / height);
  let blurhashDecodeHeight = $derived(Math.max(1, Math.round(BLURHASH_DECODE_WIDTH / aspectRatio)));
  let blurhashPixels = $derived(
    blurhash === null
      ? null
      : decodeBlurhashPixels(blurhash, BLURHASH_DECODE_WIDTH, blurhashDecodeHeight)
  );
  let retryWait = $derived(Math.max(0, backoff.at - clock));
  const loading = mediaProgress(core, () => (!url && !failed ? requested : null));
  let sizeLabel = $derived(size !== null && size > 0 ? formatByteSize(size) : null);
  let mediaLabel = $derived(
    manualGif
      ? $i18n.t(gifPlaying ? 'timeline.stopGif' : 'timeline.playGif')
      : alt
        ? $i18n.t('timeline.openMedia', { name: alt })
        : $i18n.t('timeline.openMediaUnnamed')
  );
  let retryLabel = $derived(
    retryWait === 0
      ? $i18n.t('common.retry')
      : $i18n.t('timeline.retryMediaIn', { count: Math.ceil(retryWait / 1000) })
  );
  let unavailableLabel = $derived(
    alt && !spoilerHidden
      ? `${alt}: ${$i18n.t('timeline.mediaUnavailable')}`
      : $i18n.t('timeline.mediaUnavailable')
  );

  $effect(() => {
    if (painted) onloaded?.();
  });

  $effect(() => {
    const delay = automaticMediaRetryDelay(backoff.automatic);
    if (!failed || undecodable || delay === null) return;
    const timeout = setTimeout(() => {
      backoff = { ...backoff, attempt: backoff.attempt + 1 };
    }, delay);
    return () => {
      clearTimeout(timeout);
    };
  });

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
    const key = requestKey;
    const requestSource = requested;
    const requestWidth = requestedWidth;
    const requestHeight = requestedHeight;
    const release = holdMediaUrl(core, requestSource, requestWidth, requestHeight);
    if (
      outcome?.key === key ||
      cachedMediaUrl(core, requestSource, requestWidth, requestHeight) !== undefined
    ) {
      return release;
    }

    let active = true;
    const load = attempt > 0 && forced === attempt ? retryMediaUrl : loadMediaUrl;
    void load(core, requestSource, requestWidth, requestHeight, mime)
      .then((nextUrl) => {
        if (!active) return;
        if (sideways(mediaAspectRatio(core, requestSource, requestWidth, requestHeight))) {
          sidewaysSource = source;
        }
        outcome = { key, url: nextUrl };
      })
      .catch(() => {
        if (!active) return;
        outcome = { key, url: null };
        const automatic = backoff.automatic + 1;
        backoff = { ...backoff, automatic, at: manualRetryDeadline() };
        onfailed?.();
      });

    return () => {
      active = false;
      release();
    };
  });

  $effect(() => {
    if (!url || !manualGif) return;
    let playback: GifPlayback | null = null;
    let active = true;
    void openGifPlayback(url).then((opened) => {
      if (!active || !opened) {
        opened?.close();
        return;
      }
      playback = opened;
      gifFrames = opened;
    });
    return () => {
      active = false;
      playback?.close();
      gifFrames = null;
    };
  });

  $effect(() => {
    const playback = gifFrames;
    if (!playback || !gifPlaying || paused) return;
    let running = true;
    // Read through a call: the flag is cleared from the teardown closure.
    const stopped = (): boolean => !running;
    const step = async (): Promise<void> => {
      while (!stopped()) {
        await new Promise((resolve) => setTimeout(resolve, gifFrameMs));
        if (stopped()) return;
        await paintFrame(playback, (gifFrameIndex + 1) % playback.frameCount);
      }
    };
    void step();
    return () => {
      running = false;
    };
  });

  // A canvas Svelte re-creates comes back blank, so the held frame is re-painted.
  $effect(() => {
    const playback = gifFrames;
    const canvas = gifPreview;
    if (!playback || !canvas || gifPlaying) return;
    if (canvas === paintedCanvas && gifFrameIndex === paintedIndex) return;
    // Claimed before decoding, or a second run paints the same frame again.
    paintedCanvas = canvas;
    paintedIndex = gifFrameIndex;
    void paintFrame(playback, gifFrameIndex);
  });

  $effect(() => {
    const canvas = blurhashCanvas;
    const pixels = blurhashPixels;
    if (!canvas || !pixels) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = BLURHASH_DECODE_WIDTH;
    canvas.height = blurhashDecodeHeight;
    const image = context.createImageData(canvas.width, canvas.height);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
  });

  function named(extension: string): boolean {
    return alt.toLowerCase().endsWith(extension) || source.toLowerCase().endsWith(extension);
  }

  function sameRatio(a: number, b: number): boolean {
    return Math.abs(a - b) <= ORIENTATION_TOLERANCE * b;
  }

  function sideways(ratio: number | null): boolean {
    if (ratio === null || eventRatio === null) return false;
    return !sameRatio(ratio, eventRatio) && sameRatio(ratio, 1 / eventRatio);
  }

  async function paintFrame(playback: GifPlayback, index: number): Promise<void> {
    const frame = await playback.frame(index);
    if (!frame) return;
    if (gifPreview) {
      gifPreview.width = frame.image.displayWidth;
      gifPreview.height = frame.image.displayHeight;
      gifPreview.getContext('2d')?.drawImage(frame.image, 0, 0);
    }
    frame.release();
    paintedCanvas = gifPreview;
    paintedIndex = index;
    gifFrameIndex = index;
    gifFrameMs = frame.durationMs;
    previewUrl = url;
  }

  function stopTimelinePress(event: PointerEvent): void {
    event.stopPropagation();
  }

  function manualRetryDeadline(): number {
    if (!retryable || backoff.manual === 0) return backoff.at;
    clock = Date.now();
    return clock + mediaRetryDelay(backoff.manual);
  }

  async function retry(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (retryWait > 0) return;
    if (undecodable) await core.commands.forgetMedia(requested).catch(() => undefined);
    undecodableThumbnail = null;
    outcome = null;
    const next = backoff.attempt + 1;
    backoff = { ...backoff, attempt: next, forced: next, manual: backoff.manual + 1, at: 0 };
  }

  /* The fallback where frames cannot be decoded. `drawImage` copies an animated
     image's first frame, not the one on screen, so this holds the opening frame
     however far in the reader stopped. */
  function drawFrame(): boolean {
    if (!gifPreview || !gifImage) return false;
    gifPreview.width = gifImage.naturalWidth || width;
    gifPreview.height = gifImage.naturalHeight || height;
    gifPreview.getContext('2d')?.drawImage(gifImage, 0, 0);
    return true;
  }

  function freezeFrame(): void {
    backoff = { ...backoff, manual: 0, automatic: 0, at: 0 };
    previewUrl = drawFrame() ? url : null;
  }

  function imageShown(): void {
    backoff = { ...backoff, manual: 0, automatic: 0, at: 0 };
    loadedUrl = url;
  }

  function brokenImage(): void {
    if (url) discardMediaUrl(core, requested, requestedWidth, requestedHeight, url);
    if (!asIs) {
      undecodableThumbnail = source;
      return;
    }
    outcome = { key: requestKey, url: null, undecodable: true };
    backoff = { ...backoff, at: manualRetryDeadline() };
    onfailed?.();
  }

  /* A manual GIF is its own play/stop button, so the wrapper never swaps
     element and the canvas survives. */
  function activate(): void {
    if (!manualGif) {
      onclick?.();
      return;
    }
    if (!gifPlaying) {
      playingUrl = url;
    } else if (steppedGif || drawFrame()) {
      playingUrl = null;
    }
  }

  function toggleSpoiler(): void {
    spoilerHidden = !spoilerHidden;
  }

  function withoutTabindex(props: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'tabindex'));
  }
</script>

{#snippet gifImageElement(props: Record<string, unknown>)}
  <img
    {...withoutTabindex(props)}
    bind:this={gifImage}
    class={['media-image-content', 'gif-preview-source', { ready: showCanvas }]}
    src={url}
    alt={showCanvas ? '' : alt}
    {width}
    {height}
    aria-hidden={showCanvas ? 'true' : undefined}
    onload={freezeFrame}
    onerror={brokenImage}
  />
{/snippet}

{#snippet renderImageElement(props: Record<string, unknown>)}
  <img
    {...withoutTabindex(props)}
    bind:this={imageElement}
    class={['media-image-content', { tinted }]}
    style:background-color={plate ?? undefined}
    src={heldUrl}
    {alt}
    {width}
    {height}
    decoding="async"
    onload={imageShown}
    onerror={brokenImage}
    {@attach (node) => {
      if (node instanceof HTMLImageElement && node.complete) loadedUrl = url;
    }}
  />
{/snippet}

{#snippet content()}
  {#if blurhashPixels && !showUnavailable}
    <canvas
      bind:this={blurhashCanvas}
      class={['media-image-blurhash', { loaded: painted }]}
      aria-hidden="true"
    ></canvas>
  {:else if !showUnavailable}
    <span class={['media-image-placeholder', { loaded: painted }]} aria-hidden="true">
      <ImageIcon />
    </span>
  {/if}
  {#if url && manualGif}
    <canvas
      bind:this={gifPreview}
      class={['media-image-content', 'gif-preview', { ready: showCanvas }]}>{alt}</canvas
    >
    {#if !steppedGif || !gifPreviewReady}
      {#if title}
        <Tooltip label={title} multiline>
          {#snippet trigger({ props })}{@render gifImageElement(props)}{/snippet}
        </Tooltip>
      {:else}
        {@render gifImageElement({})}
      {/if}
    {/if}
    {#if heldGif}
      <span class="play-gif" aria-hidden="true"><PlayIcon /></span>
    {/if}
  {:else if url}
    {#if title}
      <Tooltip label={title} multiline>
        {#snippet trigger({ props })}{@render renderImageElement(props)}{/snippet}
      </Tooltip>
    {:else}
      {@render renderImageElement({})}
    {/if}
    {#if tinted}
      <span class="media-image-tint" style:--media-tint="url({url})" aria-hidden="true"></span>
    {/if}
  {:else if showUnavailable}
    <span class="media-image-unavailable">
      <ImageBrokenIcon />
      <span>{unavailableLabel}</span>
      {#if retryable}
        <Button
          class="retry-media"
          size="small"
          onclick={retry}
          onpointerdown={stopTimelinePress}
          onpointermove={stopTimelinePress}
          onpointerup={stopTimelinePress}
          disabled={retryWait > 0}
        >
          {retryLabel}
        </Button>
      {/if}
    </span>
  {/if}
  {#if !showUnavailable && !url}
    <span class="media-image-progress"><Spinner small /></span>
    {#if loading.percent !== null}
      <span class="media-image-size">
        {$i18n.t('timeline.downloadProgress', { percent: loading.percent })}
      </span>
    {:else if sizeLabel}<span class="media-image-size">{sizeLabel}</span>{/if}
  {/if}
{/snippet}

{#if spoilerHidden !== undefined}
  <span
    class={[
      className,
      'media-image',
      'spoilerable-media',
      {
        interactive: !showUnavailable && (manualGif || onclick || href),
        gif: manualGif,
        pixelated,
        painted,
      },
      { spoilered: spoilerHidden && !showUnavailable },
    ]}
    {style}
    style:--media-ratio={aspectRatio}
    style:--media-width={intrinsicCssWidth}
    style:contain-intrinsic-inline-size="{width}px"
  >
    <span
      class="media-image-visual"
      aria-hidden={spoilerHidden && !showUnavailable ? 'true' : undefined}
      inert={spoilerHidden && !showUnavailable}
    >
      {#if !showUnavailable && href && !onclick}
        <a
          class="media-image-activation"
          {href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={mediaLabel}
          onpointerdown={stopTimelinePress}
          onpointermove={stopTimelinePress}
          onpointerup={stopTimelinePress}
        >
          <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
          {@render content()}
        </a>
      {:else if !showUnavailable && (manualGif || onclick)}
        <button
          class="media-image-activation"
          type="button"
          aria-label={mediaLabel}
          aria-hidden={spoilerHidden ? 'true' : undefined}
          tabindex={spoilerHidden ? -1 : undefined}
          disabled={spoilerHidden}
          onclick={activate}
          onpointerdown={stopTimelinePress}
          onpointermove={stopTimelinePress}
          onpointerup={stopTimelinePress}
        >
          <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
          {@render content()}
        </button>
      {:else}
        <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
        {@render content()}
      {/if}
    </span>
    {#if !showUnavailable}
      <ImageSpoilerControl
        hidden={spoilerHidden}
        reason={spoilerReason}
        name={spoilerName ?? alt}
        ontoggle={toggleSpoiler}
      />
    {/if}
  </span>
{:else if !showUnavailable && (manualGif || onclick)}
  <button
    class={[className, 'media-image', 'interactive', { gif: manualGif, pixelated }]}
    {style}
    style:--media-ratio={aspectRatio}
    style:--media-width={intrinsicCssWidth}
    style:contain-intrinsic-inline-size="{width}px"
    type="button"
    aria-label={mediaLabel}
    onclick={activate}
    onpointerdown={stopTimelinePress}
    onpointermove={stopTimelinePress}
    onpointerup={stopTimelinePress}
  >
    <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
    {@render content()}
  </button>
{:else}
  <span
    class={[className, 'media-image', { pixelated }]}
    {style}
    style:--media-ratio={aspectRatio}
    style:--media-width={intrinsicCssWidth}
    style:contain-intrinsic-inline-size="{width}px"
  >
    <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
    {@render content()}
  </span>
{/if}

<style>
  .media-image {
    aspect-ratio: var(--media-ratio);
    container-type: inline-size;
    display: block;
    overflow: hidden;
    position: relative;
  }

  .media-image-visual {
    display: block;
    height: 100%;
    width: 100%;
  }

  .spoilerable-media {
    background: var(--surface-var-container);
    border-radius: var(--radius);
  }

  .spoilerable-media.painted {
    background: none;
  }

  .spoilered .media-image-visual {
    filter: blur(2.75rem);
    pointer-events: none;
    transform: scale(1.15);
  }

  .media-image-activation {
    background: none;
    border: 0;
    cursor: inherit;
    display: block;
    height: 100%;
    padding: 0;
    text-align: left;
    text-decoration: none;
    width: 100%;
  }

  .media-image-content {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .media-image-content.tinted {
    opacity: 0;
  }

  .media-image-tint {
    background: currentcolor;
    inset: 0;
    mask: var(--media-tint) center / contain no-repeat;
    position: absolute;
  }

  .pixelated .media-image-content {
    image-rendering: pixelated;
  }

  .media-image-blurhash,
  .media-image-placeholder {
    filter: blur(var(--blur-small));
    height: 100%;
    inset: 0;
    opacity: 1;
    position: absolute;
    width: 100%;
  }

  .media-image-blurhash.loaded,
  .media-image-placeholder.loaded {
    filter: blur(0);
    opacity: 0;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .media-image-blurhash {
      transition:
        opacity var(--duration-slow) ease-in-out,
        filter var(--duration-slow) ease-in-out;
    }

    .media-image-placeholder {
      transition: opacity var(--duration-slow) ease-in-out;
    }
  }

  .media-image-placeholder {
    align-items: center;
    background: var(--surface-var-container);
    color: var(--surface-var-on-container);
    display: flex;
    justify-content: center;
  }

  .media-image-placeholder :global(svg) {
    height: min(40%, var(--icon-size-medium));
    width: min(40%, var(--icon-size-medium));
  }

  .media-image-progress {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    inset: 0;
    justify-content: center;
    position: absolute;
  }

  .media-image-size {
    background: var(--surface-container);
    border-radius: var(--radius-pill);
    bottom: var(--space-100);
    color: var(--surface-on-container);
    font-size: var(--font-size-small);
    padding: var(--space-050) var(--space-100);
    position: absolute;
    right: var(--space-100);
  }

  @container (max-width: 8rem) {
    .media-image-progress,
    .media-image-size {
      display: none;
    }
  }

  @container (max-width: 4rem) {
    .media-image-placeholder {
      border-radius: var(--radius);
      filter: none;
    }

    .media-image-placeholder :global(svg) {
      display: none;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    @container (max-width: 4rem) {
      :global(html:not([data-reduced-motion='on'])) .media-image-placeholder:not(.loaded) {
        animation: skeleton-pulse 1.8s ease-in-out infinite;
      }
    }
  }

  .gif-preview,
  .gif-preview-source.ready {
    display: none;
  }

  .gif-preview.ready {
    display: block;
  }

  .play-gif {
    align-items: center;
    background: var(--surface-container);
    border-radius: 50%;
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    display: flex;
    left: 50%;
    padding: var(--space-200);
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
  }

  .play-gif :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .media-image-unavailable {
    align-items: center;
    background: var(--surface-var-container);
    color: var(--surface-var-on-container);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    height: 100%;
    justify-content: center;
    padding: var(--space-200);
    text-align: center;
  }

  .media-image-unavailable :global(svg) {
    flex: none;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .media-image.interactive {
    cursor: zoom-in;
  }

  .media-image.interactive:not(.spoilerable-media) {
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
  }

  .media-image.interactive.gif {
    cursor: pointer;
  }

  .media-image-activation:focus-visible,
  .media-image.interactive:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  :global(button.retry-media) {
    margin-top: var(--space-100);
  }
</style>
