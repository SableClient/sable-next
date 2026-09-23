<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { untrack } from 'svelte';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import ImageBrokenIcon from 'phosphor-svelte/lib/ImageBrokenIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import {
    AXIS_LOCK_THRESHOLD,
    SWIPE_THRESHOLD,
    VELOCITY_THRESHOLD,
  } from '#lib/ui/swipe-gesture.js';

  import { objectSource, previewKind, type StagedFile } from './composer-files';

  interface Props {
    files: readonly StagedFile[];
    selectedId: number;
    onClose: () => void;
    onRemove: (id: number) => void;
    onToggleSpoiler: (id: number) => void;
  }

  let { files, selectedId, onClose, onRemove, onToggleSpoiler }: Props = $props();

  let currentId = $state(untrack(() => selectedId));
  let index = $derived(
    Math.max(
      0,
      files.findIndex((entry) => entry.id === currentId)
    )
  );
  let item = $derived<StagedFile | undefined>(files[index]);
  let kind = $derived(item ? previewKind(item.file) : null);
  let failedId = $state<number | null>(null);
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

  holdOverlayBack(
    () => item !== undefined,
    () => onClose()
  );

  $effect(() => {
    if (item === undefined) onClose();
  });

  function go(step: number): void {
    const next = files[index + step];
    if (next) currentId = next.id;
  }

  function remove(): void {
    if (!item) return;
    const removed = item.id;
    const neighbour = files[index + 1] ?? files[index - 1];
    if (neighbour) currentId = neighbour.id;
    onRemove(removed);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
    else return;
    event.preventDefault();
  }

  function startSwipe(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || swipe) return;
    if (event.target instanceof HTMLVideoElement) return;
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

  function trackSwipe(event: PointerEvent): void {
    if (swipe?.pointerId !== event.pointerId) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (
      swipe.axis === 'pending' &&
      (Math.abs(dx) > AXIS_LOCK_THRESHOLD || Math.abs(dy) > AXIS_LOCK_THRESHOLD)
    ) {
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }
    const elapsed = event.timeStamp - swipe.lastTime;
    if (elapsed >= 1) {
      swipe.velocityY = (event.clientY - swipe.lastY) / elapsed;
      swipe.lastY = event.clientY;
      swipe.lastTime = event.timeStamp;
    }
    if (swipe.axis === 'vertical') swipeY = Math.max(0, dy);
    if (swipe.axis === 'horizontal') {
      const edge = (dx > 0 && index === 0) || (dx < 0 && index === files.length - 1);
      swipeX = edge ? dx / 4 : dx;
    }
  }

  function endSwipe(event: PointerEvent): void {
    if (swipe?.pointerId !== event.pointerId) return;
    const { axis, velocityY } = swipe;
    const settled = { x: swipeX, y: swipeY };
    swipe = null;
    swipeX = 0;
    swipeY = 0;
    if (event.type === 'pointercancel') return;
    if (axis === 'vertical') {
      const flicked = velocityY > VELOCITY_THRESHOLD && settled.y > SWIPE_THRESHOLD / 2;
      if (settled.y > SWIPE_THRESHOLD || flicked) onClose();
    }
    if (axis === 'horizontal' && Math.abs(settled.x) > SWIPE_THRESHOLD) go(settled.x > 0 ? -1 : 1);
  }
</script>

{#if item}
  <Dialog.Root
    open
    onOpenChange={(open: boolean) => {
      if (!open) onClose();
    }}
  >
    <Dialog.Portal>
      <Dialog.Content
        class="staged-viewer"
        {...overlayLayer()}
        style={`opacity: ${String(1 - Math.min(0.6, swipeY / 400))}`}
        aria-label={$i18n.t('composer.previewTitle')}
        onkeydown={handleKeydown}
      >
        <header class="staged-viewer-bar">
          <IconButton label={$i18n.t('viewer.close')} variant="ghost" onclick={onClose}>
            <XIcon />
          </IconButton>
          <div class="staged-viewer-title">
            <strong>{item.file.name}</strong>
            <span>
              {#if files.length > 1}
                {$i18n.t('viewer.position', { index: index + 1, total: files.length })} ·
              {/if}
              {formatByteSize(item.file.size)}
            </span>
          </div>
        </header>

        <!-- Swipes duplicate the arrow keys, the close button and the nav buttons. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="staged-viewer-stage"
          class:has-nav={files.length > 1}
          onpointerdown={startSwipe}
          onpointermove={trackSwipe}
          onpointerup={endSwipe}
          onpointercancel={endSwipe}
        >
          {#if index > 0}
            <IconButton
              class="staged-viewer-nav staged-viewer-previous"
              label={$i18n.t('viewer.previous')}
              size="large"
              onclick={() => go(-1)}><ArrowLeftIcon /></IconButton
            >
          {/if}
          {#if item.spoiler}
            <span class="staged-viewer-spoiler-chip">
              <EyeSlashIcon aria-hidden="true" />
              {$i18n.t('composer.markedSpoiler')}
            </span>
          {/if}
          {#key item.id}
            {#if failedId === item.id}
              <p class="staged-viewer-failed">
                <ImageBrokenIcon aria-hidden="true" />
                {$i18n.t('composer.previewUnavailable')}
              </p>
            {:else if kind === 'video'}
              <video
                class="staged-viewer-media"
                class:swiping={swipeX !== 0 || swipeY !== 0}
                style:translate={`${String(swipeX)}px ${String(swipeY)}px`}
                controls
                playsinline
                preload="metadata"
                aria-label={item.file.name}
                {@attach objectSource(item.file)}
                onerror={() => {
                  if (item) failedId = item.id;
                }}
              ></video>
            {:else}
              <img
                class="staged-viewer-media"
                class:swiping={swipeX !== 0 || swipeY !== 0}
                style:translate={`${String(swipeX)}px ${String(swipeY)}px`}
                alt={item.file.name}
                draggable="false"
                {@attach objectSource(item.file)}
                onerror={() => {
                  if (item) failedId = item.id;
                }}
              />
            {/if}
          {/key}
          {#if index < files.length - 1}
            <IconButton
              class="staged-viewer-nav staged-viewer-next"
              label={$i18n.t('viewer.next')}
              size="large"
              onclick={() => go(1)}><ArrowRightIcon /></IconButton
            >
          {/if}
        </div>

        <footer class="staged-viewer-actions">
          <Button
            variant="ghost"
            class={['staged-viewer-spoiler', item.spoiler && 'staged-viewer-spoiler-on']}
            aria-pressed={item.spoiler}
            aria-label={$i18n.t('composer.spoilerAttachment', { name: item.file.name })}
            onclick={() => {
              if (item) onToggleSpoiler(item.id);
            }}
          >
            <EyeSlashIcon aria-hidden="true" />
            {$i18n.t('composer.spoiler')}
          </Button>
          <Button
            variant="ghost"
            aria-label={$i18n.t('composer.removeAttachment', { name: item.file.name })}
            onclick={remove}
          >
            <TrashIcon aria-hidden="true" />
            {$i18n.t('composer.remove')}
          </Button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}

<style>
  :global(.staged-viewer) {
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

  @media (prefers-reduced-motion: no-preference) {
    :global(.staged-viewer[data-state='open']) {
      animation: staged-viewer-in var(--motion-slow) var(--ease-smooth-out);
    }
  }

  @keyframes staged-viewer-in {
    from {
      opacity: 0;
    }
  }

  .staged-viewer-bar {
    align-items: center;
    display: flex;
    gap: var(--space-150);
    min-width: 0;
    padding: calc(var(--space-200) + var(--safe-top)) max(var(--space-300), var(--safe-right))
      var(--space-200) max(var(--space-300), var(--safe-left));
  }

  .staged-viewer-title {
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-width: 0;
  }

  .staged-viewer-title strong,
  .staged-viewer-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .staged-viewer-title span {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .staged-viewer-actions {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: center;
    padding: var(--space-200) max(var(--space-300), var(--safe-right))
      calc(var(--space-200) + var(--safe-bottom)) max(var(--space-300), var(--safe-left));
  }

  .staged-viewer-actions :global(.btn) {
    --button-height: var(--control-height-500);

    flex: 0 1 12rem;
  }

  .staged-viewer-actions :global(.staged-viewer-spoiler-on) {
    --button-container: var(--warn-container);
    --button-container-hover: var(--warn-container-hover);
    --button-container-active: var(--warn-container-active);
    --button-on-container: var(--warn-on-container);
  }

  .staged-viewer-spoiler-chip {
    align-items: center;
    background: var(--warn-container);
    border-radius: var(--radius-pill);
    color: var(--warn-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    inset-block-start: var(--space-200);
    inset-inline-start: 50%;
    padding: var(--space-100) var(--space-250);
    position: absolute;
    translate: -50% 0;
    z-index: 1;
  }

  .staged-viewer-spoiler-chip :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .staged-viewer-stage {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 0;
    overflow: hidden;
    padding: var(--space-200) max(var(--space-200), var(--safe-right)) var(--space-200)
      max(var(--space-200), var(--safe-left));
    position: relative;
    touch-action: none;
  }

  .staged-viewer-stage.has-nav {
    padding-inline: calc(
        max(var(--space-100), var(--safe-left)) + var(--control-height-500) + var(--space-200)
      )
      calc(max(var(--space-100), var(--safe-right)) + var(--control-height-500) + var(--space-200));
  }

  .staged-viewer-media {
    border-radius: var(--radius);
    display: block;
    max-height: 100%;
    max-width: 100%;
    object-fit: contain;
    user-select: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .staged-viewer-media:not(.swiping) {
      transition: translate var(--motion-slow) var(--ease-smooth-out);
    }
  }

  @media (pointer: coarse) {
    .staged-viewer-stage.has-nav {
      padding-inline: max(var(--space-200), var(--safe-left))
        max(var(--space-200), var(--safe-right));
    }

    .staged-viewer-stage :global(.staged-viewer-nav) {
      display: none;
    }
  }

  .staged-viewer-failed {
    color: var(--surface-var-on-container);
    display: grid;
    gap: var(--space-200);
    margin: 0;
    place-items: center;
  }

  .staged-viewer-failed :global(svg) {
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .staged-viewer-stage :global(.staged-viewer-nav) {
    position: absolute;
    top: 50%;
    translate: 0 -50%;
  }

  .staged-viewer-stage :global(.staged-viewer-previous) {
    inset-inline-start: max(var(--space-100), var(--safe-left));
  }

  .staged-viewer-stage :global(.staged-viewer-next) {
    inset-inline-end: max(var(--space-100), var(--safe-right));
  }
</style>
