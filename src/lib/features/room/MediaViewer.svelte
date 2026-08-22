<script lang="ts">
  import type { TimelineItemView } from '#src/generated/TimelineItemView';
  import { Dialog } from 'bits-ui';
  import { SvelteMap } from 'svelte/reactivity';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
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
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';

  export type MediaItem = Extract<TimelineItemView['content'], { kind: 'image' | 'sticker' }> & {
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
  let pixelated = $state(false);
  let canSaveToPhotos = $state(false);
  const touches = new SvelteMap<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let pinchZoom = 1;

  $effect(() => {
    let active = true;
    zoom = 1;
    rotation = 0;
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

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
    if (event.key === 'ArrowLeft') previous();
    if (event.key === 'ArrowRight') next();
    if (event.key === '+' || event.key === '=') zoom = Math.min(5, zoom + 0.25);
    if (event.key === '-') zoom = Math.max(0.25, zoom - 0.25);
  }

  function handleWheel(event: WheelEvent): void {
    event.preventDefault();
    zoom = Math.min(5, Math.max(0.25, zoom - event.deltaY * 0.001));
  }

  function distance(): number {
    if (touches.size !== 2) return 0;
    const [first, second] = [...touches.values()] as [
      { x: number; y: number },
      { x: number; y: number },
    ];
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function startPinch(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      pinchDistance = distance();
      pinchZoom = zoom;
    }
  }

  function movePinch(event: PointerEvent): void {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2 && pinchDistance > 0) {
      zoom = Math.min(5, Math.max(0.25, pinchZoom * (distance() / pinchDistance)));
    }
  }

  function endPinch(event: PointerEvent): void {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinchDistance = 0;
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
            <IconButton
              class="desktop-control"
              label="Copy image"
              size="medium"
              variant="ghost"
              onclick={() => void copyImage()}><CopyIcon /></IconButton
            >
            <IconButton
              label="Download image"
              size="medium"
              variant="ghost"
              onclick={() => void download()}><DownloadSimpleIcon /></IconButton
            >
            {#if canSaveToPhotos}
              <IconButton
                label="Save to photos"
                size="medium"
                variant="ghost"
                onclick={() => void saveToPhotos()}><DownloadSimpleIcon /></IconButton
              >
            {/if}
            <IconButton
              class="desktop-control"
              label="Rotate image"
              size="medium"
              variant="ghost"
              onclick={() => (rotation += 90)}><ArrowCounterClockwiseIcon /></IconButton
            >
            <button
              class:active={pixelated}
              class="pixel-toggle desktop-control"
              type="button"
              onclick={() => (pixelated = !pixelated)}
            >
              Pixelate
            </button>
          </div>
        </header>

        <main
          class="stage"
          onwheel={handleWheel}
          onpointerdown={startPinch}
          onpointermove={movePinch}
          onpointerup={endPinch}
          onpointercancel={endPinch}
        >
          {#if index > 0}
            <IconButton class="nav previous" label="Previous image" size="large" onclick={previous}
              ><ArrowLeftIcon /></IconButton
            >
          {/if}
          {#if url}
            <img
              class:pixelated
              src={url}
              alt={item.body || 'Image'}
              width={item.width ?? undefined}
              height={item.height ?? undefined}
              draggable="false"
              style:transform={`scale(${String(zoom)}) rotate(${String(rotation)}deg)`}
            />
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
          <div class="zoom-controls">
            <IconButton
              label="Zoom out"
              size="small"
              variant="ghost"
              onclick={() => (zoom = Math.max(0.25, zoom - 0.25))}><MinusIcon /></IconButton
            >
            <span>{Math.round(zoom * 100)}%</span>
            <IconButton
              label="Zoom in"
              size="small"
              variant="ghost"
              onclick={() => (zoom = Math.min(5, zoom + 0.25))}><PlusIcon /></IconButton
            >
          </div>
          <p>{item.body || 'Shared image'}</p>
          <button
            class="reset"
            type="button"
            onclick={() => {
              zoom = 1;
              rotation = 0;
            }}>Reset view</button
          >
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
    padding: calc(0.5rem + var(--safe-top)) max(0.75rem, var(--safe-left)) 0.5rem;
    position: relative;
    z-index: 1;
  }

  .bottom-bar {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    justify-content: center;
    padding: 0.5rem max(0.75rem, var(--safe-left)) calc(0.5rem + var(--safe-bottom));
  }

  .heading,
  .actions,
  .zoom-controls {
    align-items: center;
    display: flex;
    gap: 0.5rem;
    min-width: 0;
  }

  .heading {
    flex: 1;
  }

  .heading div {
    display: grid;
    gap: 0.1rem;
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
    font-size: 0.8rem;
    margin: 0;
  }

  .actions {
    flex: none;
    gap: 0.25rem;
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
    padding: 0.6rem;
  }

  .pixel-toggle.active {
    background: var(--sable-surface-container-hover);
    border-radius: 0.5rem;
    color: var(--sable-surface-on-container);
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
    padding: 0.5rem;
    position: relative;
    touch-action: none;
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
    gap: 0.4rem;
    text-align: center;
  }

  .error span {
    color: var(--sable-surface-var-on-container);
  }

  @media (width >= 48rem) {
    .toolbar {
      padding: calc(0.75rem + var(--safe-top)) max(1rem, var(--safe-left)) 0.75rem;
    }

    .bottom-bar {
      gap: 1rem;
      justify-content: space-between;
      padding: 0.75rem max(1rem, var(--safe-left)) calc(0.75rem + var(--safe-bottom));
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
      padding: 1rem;
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
