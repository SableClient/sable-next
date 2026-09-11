<script lang="ts">
  import type { TimelineItemView } from '#src/generated/protocol';
  import { Dialog } from 'bits-ui';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { tick, untrack } from 'svelte';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
  import { clampPan, type Vector2 } from '#lib/ui/pan-clamp.js';
  import {
    AXIS_LOCK_THRESHOLD,
    SWIPE_THRESHOLD,
    VELOCITY_THRESHOLD,
  } from '#lib/ui/swipe-gesture.js';
  import {
    saveFile,
    saveImageToPhotos,
    savesNatively,
    shareFile,
    sharesNatively,
    supportsPhotoLibrary,
  } from '#lib/platform/files.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import ShareNetworkIcon from 'phosphor-svelte/lib/ShareNetworkIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import PdfViewer from '#lib/ui/PdfViewer.svelte';
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
  import ImageSquareIcon from 'phosphor-svelte/lib/ImageSquareIcon';
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
  holdOverlayBack(
    () => item !== undefined,
    () => onClose()
  );
  let index = $derived(
    Math.max(
      0,
      items.findIndex((item) => item.eventId === selectedEventId)
    )
  );
  let item = $derived<MediaItem | undefined>(items[index]);
  const revealedSpoilers = new SvelteSet<string>();
  let spoiler = $derived(item?.kind === 'image' || item?.kind === 'video' ? item.spoiler : null);
  let spoilerKey = $derived(JSON.stringify([item?.eventId, item?.source, spoiler]));
  let spoilerHidden = $derived(spoiler !== null && !revealedSpoilers.has(spoilerKey));
  let source = $derived(spoilerHidden ? null : (item?.source ?? null));
  let mime = $derived(item?.mime ?? null);
  let url = $state<string | null>(null);
  let failed = $state(false);
  let zoom = $state(1);
  let rotation = $state(0);
  let pan = $state<Vector2>({ x: 0, y: 0 });
  let pixelated = $state(false);
  let canSaveToPhotos = $state(false);
  let stageEl: HTMLElement | null = $state(null);
  let imageEl: HTMLImageElement | null = $state(null);
  let fitRatio = $state(1);
  let fitsWindow = $state(true);
  let dragging = $state(false);
  let instant = $state(false);
  let instantTimer: ReturnType<typeof setTimeout> | null = null;
  let imageReady = $state(false);
  let editingZoom = $state(false);
  let zoomInput = $state('100');
  let swipeX = $state(0);
  let swipeY = $state(0);
  let swipe: {
    pointerId: number;
    startX: number;
    startY: number;
    lastY: number;
    lastTime: number;
    velocityY: number;
    axis: 'pending' | 'horizontal' | 'vertical';
  } | null = null;
  const touches = new SvelteMap<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let pinchZoom = 1;
  let panPointerId: number | null = null;
  let panOrigin: Vector2 = { x: 0, y: 0 };
  let panStartPointer: Vector2 = { x: 0, y: 0 };
  let isImage = $derived(item?.kind === 'image' || item?.kind === 'sticker');
  let isPdf = $derived(item?.kind === 'file');
  let pdfPages = $state(0);
  let pdfPage = $state(1);
  let downloadLabel = $derived(
    item?.kind === 'video'
      ? $i18n.t('viewer.downloadVideo')
      : item?.kind === 'audio'
        ? $i18n.t('viewer.downloadAudio')
        : $i18n.t('viewer.downloadImage')
  );

  function clampCurrentPan(next: Vector2): Vector2 {
    if (!stageEl || !imageEl) return next;
    return clampPan(next, stageEl.getBoundingClientRect(), imageEl.getBoundingClientRect());
  }

  $effect(() => {
    void source;
    untrack(() => {
      zoom = 1;
      rotation = 0;
      pan = { x: 0, y: 0 };
      pdfPage = 1;
      pdfPages = 0;
      fitRatio = 1;
      fitsWindow = true;
      imageReady = false;
      editingZoom = false;
    });
  });

  $effect(() => {
    const stage = stageEl;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      if (fitsWindow && isImage) fitToStage();
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
      if (instantTimer !== null) clearTimeout(instantTimer);
    };
  });

  $effect(() => {
    if (item === undefined) onClose();
  });

  $effect(() => {
    if (source === null) {
      url = null;
      failed = false;
      return;
    }

    let active = true;
    failed = false;
    const release = holdMediaUrl(core, source, 0, 0);
    const cached = cachedMediaUrl(core, source, 0, 0);
    url = cached ?? null;
    const request = cached ? Promise.resolve(cached) : loadMediaUrl(core, source, 0, 0, mime);
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

  const MIN_ZOOM = 0.1;
  const ZOOM_STEP = 0.2;
  let maxZoom = $derived(isPdf ? 5 : 500);
  let pannable = $derived(zoom > fitRatio * 1.001 || rotation % 360 !== 0);

  function applyZoom(next: number): void {
    zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, next));
    void reclampPan();
  }

  function setZoom(next: number): void {
    fitsWindow = false;
    applyZoom(next);
  }

  function fitZoom(): number {
    if (!stageEl || !imageEl?.naturalWidth || !imageEl.naturalHeight) return 1;
    const style = getComputedStyle(stageEl);
    const width =
      stageEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height =
      stageEl.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return Math.min(width / imageEl.naturalWidth, height / imageEl.naturalHeight, 1);
  }

  function fitToStage(): void {
    fitRatio = fitZoom();
    withoutTransition();
    applyZoom(fitRatio);
  }

  function onImageLoad(): void {
    fitToStage();
    imageReady = true;
  }

  function withoutTransition(): void {
    instant = true;
    if (instantTimer !== null) clearTimeout(instantTimer);
    instantTimer = setTimeout(() => {
      instant = false;
      instantTimer = null;
    }, 15);
  }

  function rotateBy(degrees: number): void {
    rotation += degrees;
    void reclampPan();
  }

  async function reclampPan(): Promise<void> {
    await tick();
    pan = pannable ? clampCurrentPan(pan) : { x: 0, y: 0 };
  }

  const PAN_STEP = 40;

  function panBy(dx: number, dy: number): void {
    pan = clampCurrentPan({ x: pan.x + dx, y: pan.y + dy });
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
    if (isImage && pannable) {
      if (event.key === 'ArrowLeft') return panBy(PAN_STEP, 0);
      if (event.key === 'ArrowRight') return panBy(-PAN_STEP, 0);
      if (event.key === 'ArrowUp') return panBy(0, PAN_STEP);
      if (event.key === 'ArrowDown') return panBy(0, -PAN_STEP);
    }
    if (event.key === 'ArrowLeft') previous();
    if (event.key === 'ArrowRight') next();
    if (event.key === '+' || event.key === '=') setZoom(zoom * (1 + ZOOM_STEP));
    if (event.key === '-') setZoom(zoom / (1 + ZOOM_STEP));
  }

  function offsetFromImageCentre(event: { clientX: number; clientY: number }): Vector2 {
    if (!stageEl) return { x: 0, y: 0 };
    const stage = stageEl.getBoundingClientRect();
    return {
      x: stage.width / 2 - (event.clientX - stage.x - pan.x),
      y: stage.height / 2 - (event.clientY - stage.y - pan.y),
    };
  }

  function zoomTowards(event: { clientX: number; clientY: number }, next: number): void {
    const target = Math.min(maxZoom, Math.max(MIN_ZOOM, next));
    const offset = offsetFromImageCentre(event);
    const growth = target / zoom - 1;
    pan = { x: pan.x + offset.x * growth, y: pan.y + offset.y * growth };
    setZoom(target);
  }

  function handleWheel(event: WheelEvent): void {
    if (!isImage) return;
    event.preventDefault();
    zoomTowards(event, zoom * (1 - event.deltaY * 0.001));
  }

  const DOUBLE_TAP_MS = 300;
  const TAP_DEBOUNCE_MS = 30;
  let lastTap = 0;

  function handleDoubleTap(event: PointerEvent): boolean {
    if (touches.size > 0) return false;

    const now = Date.now();
    const elapsed = now - lastTap;
    if (elapsed >= DOUBLE_TAP_MS || elapsed <= TAP_DEBOUNCE_MS) {
      lastTap = now;
      return false;
    }

    lastTap = 0;
    if (pannable || pan.x !== 0 || pan.y !== 0) {
      pan = { x: 0, y: 0 };
      fitsWindow = true;
      fitToStage();
      return true;
    }
    zoomTowards(event, fitRatio * 2);
    return true;
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
    if (handleDoubleTap(event)) return;
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        pinchDistance = distance();
        pinchZoom = zoom;
        panPointerId = null;
        dragging = true;
        endSwipe();
        return;
      }
      if (touches.size > 1) return;
      if (!pannable) {
        swipe = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          lastY: event.clientY,
          lastTime: event.timeStamp,
          velocityY: 0,
          axis: 'pending',
        };
      }
    }
    if (panPointerId !== null) return;
    panPointerId = event.pointerId;
    panOrigin = { ...pan };
    panStartPointer = { x: event.clientX, y: event.clientY };
    dragging = true;
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
    if (swipe?.pointerId === event.pointerId) {
      trackSwipe(event);
      return;
    }
    if (panPointerId !== event.pointerId) return;
    pan = clampCurrentPan({
      x: panOrigin.x + (event.clientX - panStartPointer.x),
      y: panOrigin.y + (event.clientY - panStartPointer.y),
    });
  }

  function trackSwipe(event: PointerEvent): void {
    if (!swipe) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (swipe.axis === 'pending') {
      if (Math.abs(dx) > AXIS_LOCK_THRESHOLD || Math.abs(dy) > AXIS_LOCK_THRESHOLD) {
        swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }
    }
    const elapsed = event.timeStamp - swipe.lastTime;
    if (elapsed >= 1) {
      swipe.velocityY = (event.clientY - swipe.lastY) / elapsed;
      swipe.lastY = event.clientY;
      swipe.lastTime = event.timeStamp;
    }
    if (swipe.axis === 'vertical') swipeY = dy;
    if (swipe.axis === 'horizontal') swipeX = dx;
  }

  function endSwipe(): void {
    swipe = null;
    swipeX = 0;
    swipeY = 0;
  }

  function releaseSwipe(pointerId: number): boolean {
    if (swipe?.pointerId !== pointerId) return false;
    const { axis, velocityY } = swipe;
    const settled = { x: swipeX, y: swipeY };
    endSwipe();
    if (axis === 'vertical') {
      const travelled = Math.abs(settled.y);
      const flicked = Math.abs(velocityY) > VELOCITY_THRESHOLD && travelled > SWIPE_THRESHOLD / 2;
      if (travelled > SWIPE_THRESHOLD || flicked) {
        onClose();
        return true;
      }
    }
    if (axis === 'horizontal' && Math.abs(settled.x) > SWIPE_THRESHOLD) {
      if (settled.x > 0) previous();
      else next();
    }
    return true;
  }

  function endPan(event: PointerEvent): void {
    if (!isImage) return;
    releaseSwipe(event.pointerId);
    touches.delete(event.pointerId);
    if (touches.size < 2) pinchDistance = 0;
    if (panPointerId === event.pointerId) panPointerId = null;
    if (panPointerId === null && touches.size === 0) dragging = false;
  }

  function beginZoomEdit(): void {
    zoomInput = String(Math.round(zoom * 100));
    editingZoom = true;
  }

  function commitZoomEdit(): void {
    const next = Number.parseInt(zoomInput, 10);
    if (!Number.isNaN(next)) setZoom(next / 100);
    editingZoom = false;
  }

  let nativeShare = $state(false);
  let canShare = $derived(nativeShare || typeof navigator.share === 'function');

  $effect(() => {
    let active = true;
    void sharesNatively().then((supported) => {
      if (active) nativeShare = supported;
    });
    return () => {
      active = false;
    };
  });

  async function shareMedia(anchor: HTMLElement): Promise<void> {
    if (!url || !item) return;
    const name = item.body || 'image';
    if (nativeShare) {
      await shareFile(url, name, item.mime ?? undefined, anchor.getBoundingClientRect());
      return;
    }
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], name, {
        type: blob.type || item.mime || 'application/octet-stream',
      });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
      await navigator.share({ title: name, text: name });
    } catch (error) {
      console.debug('[sable viewer] share dismissed', error);
    }
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
    if (!url || !item) return;
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
    if (!url || !item) return;
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
        style={`height: 100dvh; inset: 0; opacity: ${String(1 - Math.min(0.75, Math.abs(swipeY) / 400))}; position: fixed; width: 100vw;`}
        aria-label={$i18n.t('viewer.title')}
      >
        <header class="toolbar">
          <div class="heading">
            <IconButton
              label={$i18n.t('viewer.close')}
              size="medium"
              variant="ghost"
              onclick={onClose}><XIcon /></IconButton
            >
            <div>
              <strong>{item.sender}</strong>
              <span>{$i18n.t('viewer.position', { index: index + 1, total: items.length })}</span>
            </div>
          </div>
          <div class="actions">
            {#if isImage}
              <IconButton
                class="desktop-control"
                label={$i18n.t('viewer.copyImage')}
                size="medium"
                variant="ghost"
                onclick={() => void copyImage()}><CopyIcon /></IconButton
              >
            {/if}
            {#if canShare}
              <IconButton
                label={$i18n.t('viewer.share')}
                size="medium"
                variant="ghost"
                onclick={(event) => {
                  void shareMedia(event.currentTarget);
                }}><ShareNetworkIcon /></IconButton
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
                label={$i18n.t('viewer.saveToPhotos')}
                size="medium"
                variant="ghost"
                onclick={() => void saveToPhotos()}><DownloadSimpleIcon /></IconButton
              >
            {/if}
            {#if isImage}
              <IconButton
                class="desktop-control"
                label={$i18n.t('viewer.rotate')}
                size="medium"
                variant="ghost"
                onclick={() => rotateBy(90)}><ArrowCounterClockwiseIcon /></IconButton
              >
              <button
                class="pixel-toggle desktop-control choice"
                type="button"
                aria-pressed={pixelated}
                onclick={() => (pixelated = !pixelated)}
              >
                {$i18n.t('viewer.pixelate')}
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
            <IconButton
              class="nav previous"
              label={$i18n.t('viewer.previous')}
              size="large"
              onclick={previous}><ArrowLeftIcon /></IconButton
            >
          {/if}
          {#if spoilerHidden}
            <Button class="spoiler-reveal" onclick={() => revealedSpoilers.add(spoilerKey)}>
              {spoiler ? `${spoiler} — ` : ''}{$i18n.t('timeline.spoilerMedia')}
            </Button>
          {:else if url}
            {#if item.kind === 'video'}
              <!-- Matrix carries no caption track for an attachment. -->
              <!-- svelte-ignore a11y_media_has_caption -->
              <video
                class="media-player"
                controls
                src={url}
                aria-label={item.body || $i18n.t('timeline.videoAttachment')}
              >
                {item.body}
              </video>
            {:else if item.kind === 'audio'}
              <audio
                class="media-player"
                controls
                src={url}
                aria-label={item.body || $i18n.t('timeline.audioAttachment')}
              >
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
                class:dragging
                class:instant
                src={url}
                alt={item.body || $i18n.t('viewer.imageAlt')}
                draggable="false"
                style:opacity={imageReady ? undefined : 0}
                style:transform={`translate(${String(pan.x + swipeX)}px, ${String(pan.y + swipeY)}px) scale(${String(zoom)}) rotate(${String(rotation)}deg)`}
                onload={onImageLoad}
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
            <IconButton class="nav next" label={$i18n.t('viewer.next')} size="large" onclick={next}
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
              {#if isImage && fitRatio !== 1 && zoom !== 1}
                <IconButton
                  label={$i18n.t('viewer.originalSize')}
                  size="small"
                  variant="ghost"
                  onclick={() => setZoom(1)}><ImageSquareIcon /></IconButton
                >
              {/if}
              <IconButton
                label={$i18n.t('viewer.zoomOut')}
                size="small"
                variant="ghost"
                onclick={() => setZoom(zoom / (1 + ZOOM_STEP))}><MinusIcon /></IconButton
              >
              {#if editingZoom}
                <span class="zoom-level">
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    type="text"
                    inputmode="numeric"
                    aria-label={$i18n.t('viewer.setZoom')}
                    autofocus
                    bind:value={zoomInput}
                    onblur={commitZoomEdit}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') commitZoomEdit();
                    }}
                  />%
                </span>
              {:else}
                <button
                  class="zoom-level"
                  type="button"
                  title={$i18n.t('viewer.setZoom')}
                  onclick={beginZoomEdit}>{Math.round(zoom * 100)}%</button
                >
              {/if}
              <IconButton
                label={$i18n.t('viewer.zoomIn')}
                size="small"
                variant="ghost"
                onclick={() => setZoom(zoom * (1 + ZOOM_STEP))}><PlusIcon /></IconButton
              >
            </div>
          {/if}
          <p>
            {spoilerHidden ? $i18n.t('composer.spoiler') : item.body || $i18n.t('viewer.untitled')}
          </p>
          {#if isImage || isPdf}
            <button
              class="reset"
              type="button"
              onclick={() => {
                rotation = 0;
                pan = { x: 0, y: 0 };
                fitsWindow = true;
                if (isImage) fitToStage();
                else zoom = 1;
              }}>{$i18n.t('viewer.reset')}</button
            >
          {/if}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}

<style>
  :global(.viewer) {
    background: var(--surface-var-container);
    color: var(--surface-on-container);
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
    background: var(--surface-var-container);
    display: flex;
    justify-content: space-between;
    min-width: 0;
    padding: calc(var(--space-200) + var(--safe-top)) max(var(--space-300), var(--safe-left))
      var(--space-200);
    position: relative;
    z-index: 1;
  }

  .bottom-bar {
    border-top: var(--border-width) solid var(--surface-container-line);
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

  .zoom-level {
    background: none;
    border: 0;
    color: inherit;
    cursor: text;
    font: inherit;
    min-width: 4em;
    padding: 0;
    text-align: center;
  }

  .zoom-level input {
    all: unset;
    field-sizing: content;
    text-align: center;
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
    color: var(--surface-var-on-container);
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
    color: var(--primary-on-container);
    cursor: pointer;
    font: inherit;
    padding: var(--space-250);
  }

  .pixel-toggle:hover,
  .reset:hover {
    background: var(--surface-container-hover);
    border-radius: var(--radii-400);
  }

  .pixel-toggle:focus-visible,
  .reset:focus-visible {
    border-radius: var(--radii-400);
    outline: var(--focus-ring-width) solid var(--focus-ring);
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
    cursor: grab;
    display: block;
    height: auto;
    max-height: none;
    max-width: none;
    user-select: none;
    width: auto;
    will-change: transform;
  }

  .stage img.dragging {
    cursor: grabbing;
  }

  @media (prefers-reduced-motion: no-preference) {
    .stage img {
      transition: transform 100ms linear;
    }

    .stage img.dragging,
    .stage img.instant {
      transition: none;
    }
  }

  .stage img.pixelated {
    image-rendering: pixelated;
  }

  .stage .media-player {
    max-height: 100%;
    max-width: 100%;
  }

  :global(.nav) {
    background: var(--surface-container-hover);
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
  }

  :global(.nav:hover) {
    background: var(--surface-container-active);
  }

  :global(.previous) {
    left: max(0.25rem, var(--safe-left));
  }

  :global(.next) {
    right: max(0.25rem, var(--safe-right));
  }

  .error {
    color: var(--crit-on-container);
    display: grid;
    gap: var(--space-200);
    text-align: center;
  }

  .error span {
    color: var(--surface-var-on-container);
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
