<script lang="ts">
  import type { TimelineItemView } from '#src/generated/TimelineItemView';
  import { Dialog } from 'bits-ui';
  import { SvelteMap } from 'svelte/reactivity';
  import { tick, untrack } from 'svelte';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
  import { clampPan, type Vector2 } from '#lib/ui/pan-clamp.js';
  import {
    saveFile,
    saveImageToPhotos,
    savesNatively,
    supportsPhotoLibrary,
  } from '#lib/platform/files.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import PdfViewer from '#lib/ui/PdfViewer.svelte';
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';

  export type MediaItem = Extract<
    TimelineItemView['content'],
    { kind: 'image' | 'sticker' | 'video' | 'audio' | 'file' }
  > & {
    eventId: string;
    sender: string;
  };

  interface Props {
    items: readonly MediaItem[];
    selectedEventId: string;
    onClose: () => void;
  }

  let { items, selectedEventId, onClose }: Props = $props();
  const core = useCoreClient();
  let index = $derived(
    Math.max(
      0,
      items.findIndex((item) => item.eventId === selectedEventId)
    )
  );
  let item = $derived(items[index]);
  let url = $state<string | null>(null);
  let failed = $state(false);
  let zoom = $state(1);
  let rotation = $state(0);
  let pan = $state<Vector2>({ x: 0, y: 0 });
  let pixelated = $state(false);
  let canSaveToPhotos = $state(false);
  let stageEl: HTMLElement | null = $state(null);
  let imageEl: HTMLImageElement | null = $state(null);
  const touches = new SvelteMap<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let pinchZoom = 1;
  let panPointerId: number | null = null;
  let panOrigin: Vector2 = { x: 0, y: 0 };
  let panStartPointer: Vector2 = { x: 0, y: 0 };
  let isImage = $derived(item.kind === 'image' || item.kind === 'sticker');
  let isPdf = $derived(item.kind === 'file');
  let pdfPages = $state(0);
  let pdfPage = $state(1);
  let downloadLabel = $derived(
    item.kind === 'video'
      ? 'Download video'
      : item.kind === 'audio'
        ? 'Download audio'
        : 'Download image'
  );

  function clampCurrentPan(next: Vector2): Vector2 {
    if (!stageEl || !imageEl) return next;
    return clampPan(next, stageEl.getBoundingClientRect(), imageEl.getBoundingClientRect());
  }

  $effect(() => {
    void item.source;
    untrack(() => {
      zoom = 1;
      rotation = 0;
      pan = { x: 0, y: 0 };
      pdfPage = 1;
      pdfPages = 0;
    });
  });

  $effect(() => {
    let active = true;
    failed = false;
    const release = holdMediaUrl(core, item.source, 0, 0);
    const cached = cachedMediaUrl(core, item.source, 0, 0);
    url = cached ?? null;
    const request = cached
      ? Promise.resolve(cached)
      : loadMediaUrl(core, item.source, 0, 0, item.mime ?? null);
    void request
      .then((nextUrl) => {
        if (active) url = nextUrl;
      })
      .catch(() => {
        if (active) failed = true;
      });
    return () => {
      active = false;
      release();
    };
  });

  $effect(() => {
    let active = true;
    void supportsPhotoLibrary().then((supported) => {
      if (active) canSaveToPhotos = supported;
    });
    return () => {
      active = false;
    };
  });

  function previous(): void {
    if (index > 0) index -= 1;
  }

  function next(): void {
    if (index < items.length - 1) index += 1;
  }

  function setZoom(next: number): void {
    zoom = Math.min(5, Math.max(0.25, next));
    void reclampPan();
  }

  function rotateBy(degrees: number): void {
    rotation += degrees;
    void reclampPan();
  }

  async function reclampPan(): Promise<void> {
    await tick();
    pan = zoom > 1 || rotation % 360 !== 0 ? clampCurrentPan(pan) : { x: 0, y: 0 };
  }

  const PAN_STEP = 40;

  function panBy(dx: number, dy: number): void {
    pan = clampCurrentPan({ x: pan.x + dx, y: pan.y + dy });
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
    if (isImage && zoom > 1.001) {
      if (event.key === 'ArrowLeft') return panBy(PAN_STEP, 0);
      if (event.key === 'ArrowRight') return panBy(-PAN_STEP, 0);
      if (event.key === 'ArrowUp') return panBy(0, PAN_STEP);
      if (event.key === 'ArrowDown') return panBy(0, -PAN_STEP);
    }
    if (event.key === 'ArrowLeft') previous();
    if (event.key === 'ArrowRight') next();
    if (event.key === '+' || event.key === '=') setZoom(zoom + 0.25);
    if (event.key === '-') setZoom(zoom - 0.25);
  }

  function handleWheel(event: WheelEvent): void {
    if (!isImage) return;
    event.preventDefault();
    setZoom(zoom - event.deltaY * 0.001);
  }

  function distance(): number {
    if (touches.size !== 2) return 0;
    const [first, second] = [...touches.values()] as [
      { x: number; y: number },
      { x: number; y: number },
    ];
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function startPan(event: PointerEvent): void {
    if (!isImage) return;
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        pinchDistance = distance();
        pinchZoom = zoom;
        panPointerId = null;
        return;
      }
      if (touches.size > 1) return;
    }
    if (panPointerId !== null) return;
    panPointerId = event.pointerId;
    panOrigin = { ...pan };
    panStartPointer = { x: event.clientX, y: event.clientY };
  }

  function movePan(event: PointerEvent): void {
    if (!isImage) return;
    if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2 && pinchDistance > 0) {
        setZoom(pinchZoom * (distance() / pinchDistance));
        return;
      }
    }
    if (panPointerId !== event.pointerId) return;
    pan = clampCurrentPan({
      x: panOrigin.x + (event.clientX - panStartPointer.x),
      y: panOrigin.y + (event.clientY - panStartPointer.y),
    });
  }

  function endPan(event: PointerEvent): void {
    if (!isImage) return;
    touches.delete(event.pointerId);
    if (touches.size < 2) pinchDistance = 0;
    if (panPointerId === event.pointerId) panPointerId = null;
  }

  async function copyImage(): Promise<void> {
    if (!url) return;
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch {
      // Clipboard support varies across webviews; download remains available.
    }
  }

  async function download(): Promise<void> {
    if (!url) return;
    const filename = item.body || 'image';
    if (savesNatively()) {
      await saveFile(url, filename);
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  }

  async function saveToPhotos(): Promise<void> {
    if (!url) return;
    await saveImageToPhotos(url, item.body || 'image', item.mime ?? undefined);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if item}
  <Dialog.Root
    open
    onOpenChange={(open: boolean) => {
      if (!open) onClose();
    }}
  >
    <Dialog.Portal>
      <Dialog.Content
        class="viewer"
        style="height: 100dvh; inset: 0; position: fixed; width: 100vw;"
        aria-label="Media viewer"
      >
        <header class="toolbar">
          <div class="heading">
            <IconButton label="Close" size="medium" variant="ghost" onclick={onClose}
              ><XIcon /></IconButton
            >
            <div>
              <strong>{item.sender}</strong>
              <span>{index + 1} of {items.length}</span>
            </div>
          </div>
          <div class="actions">
            {#if isImage}
              <IconButton
                class="desktop-control"
                label="Copy image"
                size="medium"
                variant="ghost"
                onclick={() => void copyImage()}><CopyIcon /></IconButton
              >
            {/if}
            <IconButton
              label={downloadLabel}
              size="medium"
              variant="ghost"
              onclick={() => void download()}><DownloadSimpleIcon /></IconButton
            >
            {#if canSaveToPhotos && isImage}
              <IconButton
                label="Save to photos"
                size="medium"
                variant="ghost"
                onclick={() => void saveToPhotos()}><DownloadSimpleIcon /></IconButton
              >
            {/if}
            {#if isImage}
              <IconButton
                class="desktop-control"
                label="Rotate image"
                size="medium"
                variant="ghost"
                onclick={() => rotateBy(90)}><ArrowCounterClockwiseIcon /></IconButton
              >
              <button
                class="pixel-toggle desktop-control sable-choice"
                type="button"
                aria-pressed={pixelated}
                onclick={() => (pixelated = !pixelated)}
              >
                Pixelate
              </button>
            {/if}
          </div>
        </header>

        <main
          class="stage"
          bind:this={stageEl}
          onwheel={handleWheel}
          onpointerdown={startPan}
          onpointermove={movePan}
          onpointerup={endPan}
          onpointercancel={endPan}
        >
          {#if index > 0}
            <IconButton class="nav previous" label="Previous image" size="large" onclick={previous}
              ><ArrowLeftIcon /></IconButton
            >
          {/if}
          {#if url}
            {#if item.kind === 'video'}
              <!-- Matrix carries no caption track for an attachment. -->
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class="media-player" controls src={url} aria-label={item.body || 'Video'}>
                {item.body}
              </video>
            {:else if item.kind === 'audio'}
              <audio class="media-player" controls src={url} aria-label={item.body || 'Audio'}>
                {item.body}
              </audio>
            {:else if item.kind === 'file'}
              <PdfViewer
                src={url}
                name={item.body}
                page={pdfPage}
                {zoom}
                onPages={(pages) => {
                  pdfPages = pages;
                }}
              />
            {:else}
              <img
                bind:this={imageEl}
                class:pixelated
                src={url}
                alt={item.body || 'Image'}
                width={item.width ?? undefined}
                height={item.height ?? undefined}
                draggable="false"
                style:transform={`translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(zoom)}) rotate(${String(rotation)}deg)`}
              />
            {/if}
          {:else if failed}
            <div class="error">
              <strong>{$i18n.t('timeline.mediaUnavailable')}</strong>
              <span>{$i18n.t('timeline.mediaUnavailableDetail')}</span>
            </div>
          {:else}
            <Spinner />
          {/if}
          {#if index < items.length - 1}
            <IconButton class="nav next" label="Next image" size="large" onclick={next}
              ><ArrowRightIcon /></IconButton
            >
          {/if}
        </main>

        <footer class="bottom-bar">
          {#if isPdf && pdfPages > 1}
            <div class="zoom-controls">
              <IconButton
                label={$i18n.t('pdf.previousPage')}
                size="small"
                variant="ghost"
                disabled={pdfPage <= 1}
                onclick={() => (pdfPage -= 1)}><CaretLeftIcon /></IconButton
              >
              <span>{$i18n.t('pdf.pageIndicator', { page: pdfPage, pages: pdfPages })}</span>
              <IconButton
                label={$i18n.t('pdf.nextPage')}
                size="small"
                variant="ghost"
                disabled={pdfPage >= pdfPages}
                onclick={() => (pdfPage += 1)}><CaretRightIcon /></IconButton
              >
            </div>
          {/if}
          {#if isImage || isPdf}
            <div class="zoom-controls">
              <IconButton
                label="Zoom out"
                size="small"
                variant="ghost"
                onclick={() => setZoom(zoom - 0.25)}><MinusIcon /></IconButton
              >
              <span>{Math.round(zoom * 100)}%</span>
              <IconButton
                label="Zoom in"
                size="small"
                variant="ghost"
                onclick={() => setZoom(zoom + 0.25)}><PlusIcon /></IconButton
              >
            </div>
          {/if}
          <p>{item.body || 'Shared media'}</p>
          {#if isImage || isPdf}
            <button
              class="reset"
              type="button"
              onclick={() => {
                zoom = 1;
                rotation = 0;
                pan = { x: 0, y: 0 };
              }}>Reset view</button
            >
          {/if}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}

<style>
  :global(.viewer) {
    background: var(--sable-surface-var-container);
    color: var(--sable-surface-on-container);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100dvh;
    inset: 0;
    overscroll-behavior: contain;
    position: fixed;
    width: 100vw;
    z-index: var(--layer-dialog);
  }

  .toolbar,
  .bottom-bar {
    align-items: center;
    background: var(--sable-surface-var-container);
    display: flex;
    justify-content: space-between;
    min-width: 0;
    padding: calc(var(--space-200) + var(--safe-top)) max(var(--space-300), var(--safe-left))
      var(--space-200);
    position: relative;
    z-index: 1;
  }

  .bottom-bar {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    justify-content: center;
    padding: var(--space-200) max(var(--space-300), var(--safe-left))
      calc(var(--space-200) + var(--safe-bottom));
  }

  .heading,
  .actions,
  .zoom-controls {
    align-items: center;
    display: flex;
    gap: var(--space-150);
    min-width: 0;
  }

  .heading {
    flex: 1;
  }

  .heading div {
    display: grid;
    gap: var(--space-050);
    min-width: 0;
  }

  .heading strong,
  .heading span,
  .bottom-bar p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .heading span,
  .bottom-bar p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    flex: none;
    gap: var(--space-100);
  }

  .desktop-control,
  .zoom-controls,
  .bottom-bar p,
  .reset {
    display: none;
  }

  .pixel-toggle,
  .reset {
    background: none;
    border: 0;
    color: var(--sable-primary-on-container);
    cursor: pointer;
    font: inherit;
    padding: var(--space-250);
  }

  .pixel-toggle:hover,
  .reset:hover {
    background: var(--sable-surface-container-hover);
    border-radius: 0.5rem;
  }

  .pixel-toggle:focus-visible,
  .reset:focus-visible {
    border-radius: 0.5rem;
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 0.15rem;
  }

  .stage {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 0;
    overflow: hidden;
    padding: var(--space-200);
    position: relative;
    touch-action: none;
  }

  .stage :global(.pdf-viewer) {
    height: 100%;
    width: 100%;
  }

  .stage img {
    max-height: 100%;
    max-width: 100%;
    object-fit: contain;
    user-select: none;
  }

  .stage img.pixelated {
    image-rendering: pixelated;
  }

  .stage .media-player {
    max-height: 100%;
    max-width: 100%;
  }

  :global(.nav) {
    background: var(--sable-surface-container-hover);
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
  }

  :global(.nav:hover) {
    background: var(--sable-surface-container-active);
  }

  :global(.previous) {
    left: max(0.25rem, var(--safe-left));
  }

  :global(.next) {
    right: max(0.25rem, var(--safe-right));
  }

  .error {
    color: var(--sable-crit-on-container);
    display: grid;
    gap: var(--space-200);
    text-align: center;
  }

  .error span {
    color: var(--sable-surface-var-on-container);
  }

  @media (width >= 48rem) {
    .toolbar {
      padding: calc(var(--space-300) + var(--safe-top)) max(var(--space-400), var(--safe-left))
        var(--space-300);
    }

    .bottom-bar {
      gap: var(--space-400);
      justify-content: space-between;
      padding: var(--space-300) max(var(--space-400), var(--safe-left))
        calc(var(--space-300) + var(--safe-bottom));
    }

    .desktop-control,
    .bottom-bar p,
    .reset {
      display: initial;
    }

    .zoom-controls {
      display: flex;
    }

    .stage {
      padding: var(--space-400);
    }

    :global(.previous) {
      left: 1.5rem;
    }

    :global(.next) {
      right: 1.5rem;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .stage img {
      transition: transform 160ms ease;
    }
  }
</style>
