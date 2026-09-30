<script module lang="ts">
  export type { MediaItem } from './media-viewer-types';
</script>

<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { SvelteMap } from 'svelte/reactivity';
  import { flushSync, onDestroy, tick, untrack } from 'svelte';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { isEncryptedMedia } from '#lib/ui/media-url.js';
  import { mediaProgress } from '#lib/ui/media-progress.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import ImageSpoilerControl from '#lib/ui/ImageSpoilerControl.svelte';
  import { videoStreamingSupported } from '#lib/ui/video-stream.svelte.js';
  import { canPlayVideo } from '#lib/ui/video-support.js';
  import { clampPan, type Vector2 } from '#lib/ui/pan-clamp.js';
  import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { mouseContextMenu } from '#lib/ui/long-press.svelte.js';
  import { pixelatedImage } from '#lib/ui/pixelated.js';
  import {
    AXIS_LOCK_THRESHOLD,
    SWIPE_THRESHOLD,
    VELOCITY_THRESHOLD,
  } from '#lib/ui/swipe-gesture.js';
  import { sharesNatively, supportsPhotoLibrary } from '#lib/platform/files.js';
  import { setSystemBarsHidden } from '#lib/platform/system-bars.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
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
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { MediaViewerActions } from './media-viewer-actions';
  import { MediaViewerResource } from './media-viewer-resource.svelte';
  import type { MediaItem } from './media-viewer-types';
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
  import ImageSquareIcon from 'phosphor-svelte/lib/ImageSquareIcon';
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import FileArrowDownIcon from 'phosphor-svelte/lib/FileArrowDownIcon';
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
  import ChatCenteredTextIcon from 'phosphor-svelte/lib/ChatCenteredTextIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
  import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';

  interface Props {
    items: readonly MediaItem[];
    selectedEventId: string;
    onClose: () => void;
    onJump?: (eventId: string) => void;
  }

  let { items, selectedEventId, onClose, onJump }: Props = $props();
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
  const spoilerVisibility = new SvelteMap<string, boolean>();
  let spoiler = $derived(item?.kind === 'image' || item?.kind === 'video' ? item.spoiler : null);
  let spoilerKey = $derived(JSON.stringify([item?.eventId, item?.source, spoiler]));
  let spoilerHidden = $derived(spoilerVisibility.get(spoilerKey) ?? spoiler !== null);
  let source = $derived(spoilerHidden && item?.kind === 'video' ? null : (item?.source ?? null));
  let mime = $derived(item?.mime ?? null);
  let fileName = $derived(
    item === undefined ? '' : item.kind === 'sticker' ? item.body : item.filename
  );
  let mediaLabel = $derived(
    item === undefined ? '' : item.kind === 'sticker' ? item.body : (item.caption ?? item.filename)
  );
  let visibleLabel = $derived(
    spoilerHidden ? $i18n.t('composer.spoiler') : mediaLabel || $i18n.t('viewer.untitled')
  );
  const resource = new MediaViewerResource(core, () => videoEl?.currentTime ?? 0);
  let url = $derived(resource.url);
  const mediaActions = new MediaViewerActions(
    () => ({ url, item, fileName }),
    () => ({
      copied: $i18n.t('viewer.imageCopied'),
      copyFailed: $i18n.t('viewer.copyFailed'),
      saved: $i18n.t('viewer.saved'),
      saveFailed: $i18n.t('errors.actionFailed'),
    })
  );
  const loading = mediaProgress(core, () => (!url && !failed ? source : null));
  let preview = $derived(
    item?.kind === 'image' && (item.thumbnail !== null || !isEncryptedMedia(item.source))
      ? item
      : null
  );
  let videoEl = $state<HTMLVideoElement>();
  let failed = $derived(resource.failed);
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
  let imageReady = $state(false);
  let imageMenuOpen = $state(false);
  let imageMenuAnchor = $state.raw<CursorAnchor | null>(null);
  let editingZoom = $state(false);
  let zoomInput = $state('100');
  let swipeX = $state(0);
  let swipeY = $state(0);
  let chromeHidden = $state(false);
  let tap: { pointerId: number; x: number; y: number } | null = null;
  let backdropPress: { pointerId: number; x: number; y: number } | null = null;
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
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
  let streamUnavailable = $derived(resource.streamUnavailable);
  let transcode = $derived(
    item?.kind === 'video' &&
      !canPlayVideo(mime) &&
      !streamUnavailable &&
      videoStreamingSupported(core)
  );
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
      pixelated =
        item?.kind === 'image' || item?.kind === 'sticker'
          ? pixelatedImage(preferences.pixelatedImages, item.width, item.height)
          : false;
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
    };
  });

  $effect(() => {
    if (item === undefined) onClose();
  });

  $effect(() => {
    if (!chromeHidden) return;
    setSystemBarsHidden(true);
    return () => {
      setSystemBarsHidden(false);
    };
  });

  $effect(() => {
    return resource.load(source, mime, transcode);
  });

  onDestroy(() => {
    resource.dispose();
    clearTimeout(tapTimer);
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
    instant = true;
    applyZoom(fitRatio);
    flushSync();
    if (imageEl) void getComputedStyle(imageEl).transform;
    instant = false;
  }

  function onImageLoad(): void {
    fitToStage();
    imageReady = true;
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
    if (event.defaultPrevented || imageMenuOpen) return;
    if (event.key === 'Escape') onClose();
    if (isImage && !spoilerHidden && pannable) {
      if (event.key === 'ArrowLeft') return panBy(PAN_STEP, 0);
      if (event.key === 'ArrowRight') return panBy(-PAN_STEP, 0);
      if (event.key === 'ArrowUp') return panBy(0, PAN_STEP);
      if (event.key === 'ArrowDown') return panBy(0, -PAN_STEP);
    }
    if (isPdf && pdfPages > 1) {
      if (event.key === 'PageDown') return void (pdfPage = Math.min(pdfPages, pdfPage + 1));
      if (event.key === 'PageUp') return void (pdfPage = Math.max(1, pdfPage - 1));
      if (event.key === 'Home') return void (pdfPage = 1);
      if (event.key === 'End') return void (pdfPage = pdfPages);
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
    if (isPdf) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(zoom * (1 - event.deltaY * 0.01));
      return;
    }
    if (!isImage || spoilerHidden) return;
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

  function toggleFileZoom(event: MouseEvent): void {
    if (!isPdf || event.button !== 0 || event.target instanceof HTMLButtonElement) return;
    setZoom(zoom === 1 ? 2 : 1);
  }

  function startPan(event: PointerEvent): void {
    backdropPress =
      event.target === stageEl &&
      event.pointerType === 'mouse' &&
      event.button === 0 &&
      !imageMenuOpen &&
      window.matchMedia('(width >= 48rem)').matches
        ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
    if (!isImage || spoilerHidden) return;
    if (event.button !== 0) return;
    clearTimeout(tapTimer);
    if (!backdropPress && handleDoubleTap(event)) return;
    if (event.pointerType === 'touch') {
      tap =
        touches.size === 0 && !(event.target instanceof Element && event.target.closest('button'))
          ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
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
    if (
      backdropPress?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - backdropPress.x, event.clientY - backdropPress.y) >
        AXIS_LOCK_THRESHOLD
    ) {
      backdropPress = null;
    }
    if (!isImage) return;
    if (
      tap?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > AXIS_LOCK_THRESHOLD
    ) {
      tap = null;
    }
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
    if (backdropPress?.pointerId === event.pointerId) {
      backdropPress = null;
      if (event.type === 'pointerup' && event.target === stageEl) onClose();
    }
    if (!isImage) return;
    if (tap?.pointerId === event.pointerId) {
      if (event.type === 'pointerup') {
        tapTimer = setTimeout(() => {
          chromeHidden = !chromeHidden;
        }, DOUBLE_TAP_MS);
      }
      tap = null;
    }
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

  function openImageMenu(event: MouseEvent): void {
    event.preventDefault();
    imageMenuAnchor = cursorAnchor(event);
    imageMenuOpen = true;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet saveTrigger({ props }: { props: Record<string, unknown> })}
  <IconButton {...props} label={downloadLabel} size="medium" variant="ghost">
    <DownloadSimpleIcon />
  </IconButton>
{/snippet}

{#if item}
  <Dialog.Root
    open
    onOpenChange={(open: boolean) => {
      if (!open) onClose();
    }}
  >
    <Dialog.Portal>
      <Dialog.Content
        class={chromeHidden ? 'viewer immersive' : 'viewer'}
        {...overlayLayer()}
        style={`height: calc(100dvh - var(--titlebar-height)); inset: var(--titlebar-height) 0 0; opacity: ${String(1 - Math.min(0.75, Math.abs(swipeY) / 400))}; position: fixed; width: 100vw;`}
        aria-label={$i18n.t('viewer.title')}
        onInteractOutside={(event: PointerEvent) => {
          if (event.target instanceof Element && event.target.closest('.titlebar')) {
            event.preventDefault();
          }
        }}
      >
        <header class="toolbar" class:chrome-hidden={chromeHidden}>
          <div class="heading">
            <strong>{item.sender}</strong>
            <span title={visibleLabel}
              >{$i18n.t('viewer.position', { index: index + 1, total: items.length })} · {visibleLabel}</span
            >
          </div>
          <div class="actions">
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
            {#if canShare}
              <IconButton
                label={$i18n.t('viewer.share')}
                size="medium"
                variant="ghost"
                onclick={(event) => {
                  void mediaActions.share(event.currentTarget, nativeShare);
                }}><ShareNetworkIcon /></IconButton
              >
            {/if}
            {#if canSaveToPhotos && isImage}
              <ActionMenu label={downloadLabel} trigger={saveTrigger}>
                <ActionMenuItem onSelect={() => void mediaActions.download()}>
                  <FileArrowDownIcon />
                  {$i18n.t('viewer.saveToFiles')}
                </ActionMenuItem>
                <ActionMenuItem onSelect={() => void mediaActions.saveToPhotos()}>
                  <ImagesIcon />
                  {$i18n.t('viewer.saveToPhotos')}
                </ActionMenuItem>
              </ActionMenu>
            {:else}
              <IconButton
                label={downloadLabel}
                size="medium"
                variant="ghost"
                onclick={() => void mediaActions.download()}><DownloadSimpleIcon /></IconButton
              >
            {/if}
            {#if isImage || isPdf || onJump}
              <ActionMenu label={$i18n.t('timeline.moreActions')}>
                {#snippet trigger({ props })}
                  <IconButton
                    {...props}
                    label={$i18n.t('timeline.moreActions')}
                    size="medium"
                    variant="ghost"><DotsThreeIcon /></IconButton
                  >
                {/snippet}
                {#if isImage}
                  <ActionMenuItem onSelect={() => void mediaActions.copyImage()}>
                    <CopyIcon />
                    {$i18n.t('viewer.copyImage')}
                  </ActionMenuItem>
                  <ActionMenuItem onSelect={() => rotateBy(90)}>
                    <ArrowClockwiseIcon />
                    {$i18n.t('viewer.rotate')}
                  </ActionMenuItem>
                  <ActionMenuItem checked={pixelated} onSelect={() => (pixelated = !pixelated)}>
                    <SquaresFourIcon />
                    {$i18n.t('viewer.pixelate')}
                  </ActionMenuItem>
                  <ActionMenuItem
                    onSelect={() => spoilerVisibility.set(spoilerKey, !spoilerHidden)}
                  >
                    {#if spoilerHidden}<EyeIcon />{:else}<EyeSlashIcon />{/if}
                    {$i18n.t(
                      spoilerHidden ? 'timeline.revealImageUnnamed' : 'timeline.hideImageUnnamed'
                    )}
                  </ActionMenuItem>
                {/if}
                {#if isImage || isPdf}
                  <ActionMenuItem
                    onSelect={() => {
                      rotation = 0;
                      pan = { x: 0, y: 0 };
                      fitsWindow = true;
                      if (isImage) fitToStage();
                      else zoom = 1;
                    }}
                  >
                    <ArrowCounterClockwiseIcon />
                    {$i18n.t('viewer.reset')}
                  </ActionMenuItem>
                {/if}
                {#if onJump}
                  {#if isImage || isPdf}<ActionMenuSeparator />{/if}
                  <ActionMenuItem
                    onSelect={() => {
                      if (item) onJump(item.eventId);
                    }}
                  >
                    <ChatCenteredTextIcon />
                    {$i18n.t('viewer.jumpToMessage')}
                  </ActionMenuItem>
                {/if}
              </ActionMenu>
            {/if}
            <IconButton
              class="close-button"
              label={$i18n.t('viewer.close')}
              size="medium"
              variant="ghost"
              onclick={onClose}><XIcon /></IconButton
            >
          </div>
        </header>

        <main
          class="stage"
          class:spoilered={spoilerHidden}
          class:has-nav={items.length > 1}
          class:chrome-hidden={chromeHidden}
          bind:this={stageEl}
          onwheel={handleWheel}
          onpointerdown={startPan}
          ondblclick={toggleFileZoom}
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
          {#if spoilerHidden && !isImage}
            <Button class="spoiler-reveal" onclick={() => spoilerVisibility.set(spoilerKey, false)}>
              {spoiler ? `${spoiler} — ` : ''}{$i18n.t('timeline.spoilerMedia')}
            </Button>
          {:else if url}
            {#if item.kind === 'video'}
              <!-- Matrix carries no caption track for an attachment. -->
              <!-- svelte-ignore a11y_media_has_caption -->
              <video
                bind:this={videoEl}
                class="media-player"
                controls
                src={url}
                aria-label={mediaLabel || $i18n.t('timeline.videoAttachment')}
              >
                {fileName}
              </video>
            {:else if item.kind === 'audio'}
              <audio
                class="media-player"
                controls
                src={url}
                aria-label={mediaLabel || $i18n.t('timeline.audioAttachment')}
              >
                {fileName}
              </audio>
            {:else if item.kind === 'file'}
              <PdfViewer
                src={url}
                name={fileName}
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
                class:spoilered={spoilerHidden}
                src={url}
                alt={spoilerHidden ? '' : mediaLabel || $i18n.t('viewer.imageAlt')}
                aria-hidden={spoilerHidden ? 'true' : undefined}
                draggable="false"
                style:opacity={imageReady ? undefined : 0}
                style:transform={`translate(${String(pan.x + swipeX)}px, ${String(pan.y + swipeY)}px) scale(${String(zoom)}) rotate(${String(rotation)}deg)`}
                onload={onImageLoad}
                oncontextmenu={mouseContextMenu(openImageMenu)}
              />
              <ActionMenu
                bind:open={imageMenuOpen}
                label={$i18n.t('viewer.imageMenu')}
                anchor={imageMenuAnchor}
                side="bottom"
                align="start"
                preventScroll={false}
              >
                <ActionMenuItem onSelect={() => void mediaActions.copyImage()}>
                  <CopyIcon />
                  {$i18n.t('viewer.copyImage')}
                </ActionMenuItem>
                <ActionMenuItem onSelect={() => void mediaActions.download()}>
                  <DownloadSimpleIcon />
                  {downloadLabel}
                </ActionMenuItem>
              </ActionMenu>
            {/if}
          {:else if failed}
            <div class="error">
              <strong>{$i18n.t('timeline.mediaUnavailable')}</strong>
              <span>{$i18n.t('timeline.mediaUnavailableDetail')}</span>
            </div>
          {:else}
            {#if preview}
              <MediaImage
                class="viewer-preview"
                source={preview.source}
                thumbnail={preview.thumbnail}
                alt=""
                width={800}
                height={600}
                intrinsicWidth={preview.width}
                intrinsicHeight={preview.height}
                mime={preview.mime}
                blurhash={preview.blurhash}
              />
            {/if}
            <span class="loading">
              <Spinner label={$i18n.t('a11y.loading')} />
              {#if loading.percent !== null}
                <span>{$i18n.t('timeline.downloadProgress', { percent: loading.percent })}</span>
              {/if}
            </span>
          {/if}
          {#if isImage && spoilerHidden}
            <ImageSpoilerControl
              hidden
              reason={spoiler}
              name={fileName}
              ontoggle={() => spoilerVisibility.set(spoilerKey, false)}
            />
          {/if}
          {#if index < items.length - 1}
            <IconButton class="nav next" label={$i18n.t('viewer.next')} size="large" onclick={next}
              ><ArrowRightIcon /></IconButton
            >
          {/if}
        </main>

        {#if isPdf && pdfPages > 1}
          <footer class="bottom-bar" class:chrome-hidden={chromeHidden}>
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
          </footer>
        {/if}
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
  }

  :global(.viewer.immersive) {
    background: var(--viewer-immersive);
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
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-width: 0;
  }

  .heading strong,
  .heading span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .heading span {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .actions {
    flex: none;
    gap: var(--space-100);
  }

  .actions :global(.close-button) {
    margin-inline-start: var(--space-200);
  }

  .zoom-controls {
    display: none;
  }

  .actions .zoom-controls {
    margin-inline-end: var(--space-200);
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

  .stage.has-nav {
    padding-inline: calc(
        max(var(--space-100), var(--safe-left)) + var(--control-height-500) + var(--space-200)
      )
      calc(max(var(--space-100), var(--safe-right)) + var(--control-height-500) + var(--space-200));
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

  .stage img.spoilered,
  .stage.spoilered :global(.viewer-preview) {
    filter: blur(2.75rem);
    pointer-events: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .stage img {
      transition: transform var(--motion-normal) var(--ease-smooth-out);
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

  .toolbar.chrome-hidden,
  .bottom-bar.chrome-hidden,
  .stage.chrome-hidden :global(.nav) {
    opacity: 0;
    visibility: hidden;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.viewer) {
      transition: background-color var(--motion-normal) var(--ease-smooth-out);
    }

    .toolbar,
    .bottom-bar,
    :global(.nav) {
      transition:
        opacity var(--motion-normal) var(--ease-smooth-out),
        visibility var(--motion-normal);
    }
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

  @media (width < 48rem) {
    .stage.has-nav {
      padding-inline: var(--space-200);
    }

    :global(.nav) {
      display: none;
    }

    :global(.viewer) {
      grid-template-rows: minmax(0, 1fr);
    }

    .toolbar,
    .bottom-bar {
      background: color-mix(in srgb, var(--surface-var-container) 85%, transparent);
      inset-inline: 0;
      position: absolute;
    }

    .toolbar {
      inset-block-start: 0;
    }

    .bottom-bar {
      border-top: 0;
      inset-block-end: 0;
    }
  }

  .stage :global(.viewer-preview) {
    aspect-ratio: auto;
    inset: var(--space-200);
    position: absolute;
  }

  .stage :global(.viewer-preview :is(.media-image-content, .media-image-blurhash)) {
    object-fit: contain;
  }

  .stage
    :global(
      .viewer-preview
        :is(
          .media-image-placeholder,
          .media-image-progress,
          .media-image-size,
          .media-image-unavailable
        )
    ) {
    display: none;
  }

  .loading {
    align-items: center;
    background: var(--surface-container);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-100) var(--space-200);
    position: relative;
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
    :global(.viewer) {
      background: color-mix(in srgb, var(--viewer-immersive) 90%, transparent);
    }

    .error,
    .error span {
      color: var(--media-on-scrim);
    }

    .toolbar {
      padding: calc(var(--space-300) + var(--safe-top)) max(var(--space-400), var(--safe-left))
        var(--space-300);
    }

    .bottom-bar {
      padding: var(--space-300) max(var(--space-400), var(--safe-left))
        calc(var(--space-300) + var(--safe-bottom));
    }

    .zoom-controls {
      display: flex;
    }

    .stage {
      padding: var(--space-400);
    }

    .stage.has-nav {
      padding-inline: calc(var(--space-600) + var(--control-height-500) + var(--space-200));
    }

    :global(.previous) {
      left: 1.5rem;
    }

    :global(.next) {
      right: 1.5rem;
    }
  }
</style>
