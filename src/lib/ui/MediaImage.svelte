<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { decodeBlurhashPixels } from '#lib/ui/blurhash.js';
  import { dominantColor } from '#lib/ui/dominant-color.js';
  import { DEFAULT_FRAME_MS, openGifPlayback, type GifPlayback } from '#lib/ui/gif-frames.js';
  import {
    cachedMediaUrl,
    holdMediaUrl,
    loadMediaUrl,
    mediaAspectRatio,
    retryMediaUrl,
  } from '#lib/ui/media-url.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ImageBrokenIcon from 'phosphor-svelte/lib/ImageBrokenIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  const BLURHASH_DECODE_WIDTH = 32;

  interface Props {
    source: string;
    alt: string;
    width: number;
    height: number;
    intrinsicWidth?: number | null;
    intrinsicHeight?: number | null;
    mime?: string | null;
    blurhash?: string | null;
    class?: string;
    onclick?: () => void;
    onfailed?: () => void;
    retryable?: boolean;
    uniform?: boolean;
    original?: boolean;
  }

  let {
    source,
    alt,
    width,
    height,
    intrinsicWidth = null,
    intrinsicHeight = null,
    mime = null,
    blurhash = null,
    class: className = '',
    onclick,
    onfailed,
    retryable = false,
    uniform = false,
    original = false,
  }: Props = $props();
  const core = useCoreClient();
  let url = $state<string | null>(null);
  let failed = $state(false);
  let retryCount = $state(0);
  let retryAt = $state(0);
  let clock = $state(Date.now());
  let loadGeneration = $state(0);
  let retryNextLoad = false;
  let gifPreview = $state<HTMLCanvasElement>();
  let gifImage = $state<HTMLImageElement>();
  let gifPreviewReady = $state(false);
  let gifPlaying = $state(false);
  let gifFrames = $state<GifPlayback | null>(null);
  /* Not `$state`: the loop would restart on every step if it tracked these. */
  let gifFrameIndex = 0;
  let gifFrameMs = DEFAULT_FRAME_MS;
  let paintedCanvas: HTMLCanvasElement | undefined;
  let paintedIndex = -1;
  let fileRatio = $state<number | null>(null);
  let blurhashCanvas = $state<HTMLCanvasElement>();
  let imageLoaded = $state(false);
  let imageElement = $state<HTMLImageElement>();
  let plate = $derived.by(() => {
    if (!uniform || !preferences.uniformIcons || !imageLoaded) return null;
    const image = imageElement;
    if (!image?.complete) return null;
    return dominantColor(image);
  });
  let animatedGif = $derived(mime === 'image/gif');
  let manualGif = $derived(animatedGif && !preferences.autoplayGifs);
  let steppedGif = $derived(gifFrames !== null);
  let heldGif = $derived(manualGif && !gifPlaying && gifPreviewReady);
  let showCanvas = $derived(manualGif && gifPreviewReady && (steppedGif || !gifPlaying));
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
  let unavailableLabel = $derived(
    alt ? `${alt}: ${$i18n.t('timeline.mediaUnavailable')}` : $i18n.t('timeline.mediaUnavailable')
  );
  let retryWait = $derived(Math.max(0, retryAt - clock));
  let mediaLabel = $derived(
    manualGif
      ? $i18n.t(gifPlaying ? 'timeline.stopGif' : 'timeline.playGif')
      : `Open ${alt || 'media'}`
  );
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

  $effect(() => {
    let active = true;
    const retry = loadGeneration > 0 && retryNextLoad;
    retryNextLoad = false;
    const asIs = original || mime === 'image/svg+xml' || animatedGif;
    const requestWidth = asIs ? 0 : width;
    const requestHeight = asIs ? 0 : height;
    const release = holdMediaUrl(core, source, requestWidth, requestHeight);
    const cached = cachedMediaUrl(core, source, requestWidth, requestHeight);
    if (cached !== undefined) {
      fileRatio = mediaAspectRatio(core, source);
      gifPreviewReady = false;
      gifPlaying = false;
      if (url !== cached) imageLoaded = false;
      url = cached;
      return release;
    }

    url = null;
    failed = false;
    fileRatio = null;
    gifPreviewReady = false;
    gifPlaying = false;
    imageLoaded = false;
    const load = retry ? retryMediaUrl : loadMediaUrl;
    void load(core, source, requestWidth, requestHeight, mime)
      .then((nextUrl) => {
        if (!active) return;
        fileRatio = mediaAspectRatio(core, source);
        gifPreviewReady = false;
        gifPlaying = false;
        url = nextUrl;
      })
      .catch(() => {
        if (!active) return;
        failed = true;
        if (retryable && retryCount > 0) {
          retryAt = Date.now() + Math.min(2 ** retryCount * 1000, 30_000);
          clock = Date.now();
        }
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
    if (!playback || !gifPlaying) return;
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

  async function paintFrame(playback: GifPlayback, index: number): Promise<void> {
    const frame = await playback.frame(index);
    if (!frame) return;
    if (gifPreview) {
      gifPreview.width = frame.image.displayWidth;
      gifPreview.height = frame.image.displayHeight;
      gifPreview.getContext('2d')?.drawImage(frame.image, 0, 0);
    }
    frame.image.close();
    paintedCanvas = gifPreview;
    paintedIndex = index;
    gifFrameIndex = index;
    gifFrameMs = frame.durationMs;
    gifPreviewReady = true;
  }

  function stopTimelinePress(event: PointerEvent): void {
    event.stopPropagation();
  }

  function retry(event: MouseEvent): void {
    event.stopPropagation();
    if (retryWait > 0) return;
    retryCount += 1;
    retryAt = 0;
    failed = false;
    retryNextLoad = true;
    loadGeneration += 1;
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
    gifPreviewReady = drawFrame();
  }

  /* A manual GIF is its own play/stop button, so the wrapper never swaps
     element and the canvas survives. */
  function activate(): void {
    if (!manualGif) {
      onclick?.();
      return;
    }
    if (!gifPlaying) {
      gifPlaying = true;
    } else if (steppedGif || drawFrame()) {
      gifPlaying = false;
    }
  }
</script>

{#snippet content()}
  {#if blurhash && !manualGif && !failed}
    <canvas
      bind:this={blurhashCanvas}
      class={['media-image-blurhash', { loaded: imageLoaded }]}
      aria-hidden="true"
    ></canvas>
  {/if}
  {#if url && manualGif}
    <canvas
      bind:this={gifPreview}
      class={['media-image-content', 'gif-preview', { ready: showCanvas }]}>{alt}</canvas
    >
    {#if !steppedGif}
      <img
        bind:this={gifImage}
        class={['media-image-content', 'gif-preview-source', { ready: showCanvas }]}
        src={url}
        alt={showCanvas ? '' : alt}
        {width}
        {height}
        aria-hidden={showCanvas ? 'true' : undefined}
        onload={freezeFrame}
      />
    {/if}
    {#if heldGif}
      <span class="play-gif" aria-hidden="true"><PlayIcon /></span>
    {/if}
  {:else if url}
    <img
      bind:this={imageElement}
      class="media-image-content"
      style:background-color={plate ?? undefined}
      src={url}
      {alt}
      {width}
      {height}
      onload={() => (imageLoaded = true)}
      {@attach (node) => {
        if (node instanceof HTMLImageElement && node.complete) imageLoaded = true;
      }}
    />
  {:else if failed}
    <span class="media-image-unavailable">
      <ImageBrokenIcon />
      <span>{unavailableLabel}</span>
      {#if retryable}
        <Button class="retry-media" size="small" onclick={retry} disabled={retryWait > 0}>
          {retryLabel}
        </Button>
      {/if}
    </span>
  {/if}
{/snippet}

{#if !failed && (manualGif || onclick)}
  <button
    class={[className, 'media-image', 'interactive', { gif: manualGif }]}
    style:--media-ratio={aspectRatio}
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
  <span class={[className, 'media-image']} style:--media-ratio={aspectRatio}>
    <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
    {@render content()}
  </span>
{/if}

<style>
  .media-image {
    aspect-ratio: var(--media-ratio);
    display: block;
    overflow: hidden;
    position: relative;
  }

  .media-image-content {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .media-image-blurhash {
    height: 100%;
    inset: 0;
    opacity: 1;
    position: absolute;
    transition: opacity var(--motion-fast) var(--motion-easing-standard);
    width: 100%;
  }

  .media-image-blurhash.loaded {
    opacity: 0;
    pointer-events: none;
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
    background: var(--sable-surface-container);
    border-radius: 50%;
    box-shadow: var(--shadow-float);
    color: var(--sable-surface-on-container);
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
    background: var(--sable-surface-container);
    color: var(--sable-surface-on-container);
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
    background: none;
    border: 0;
    cursor: zoom-in;
    padding: 0;
    text-align: left;
  }

  .media-image.interactive.gif {
    cursor: pointer;
  }

  .media-image.interactive:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 0.2rem;
  }

  :global(button.retry-media) {
    margin-top: var(--space-100);
  }
</style>
