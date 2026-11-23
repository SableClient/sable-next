<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
  import ImageBrokenIcon from 'phosphor-svelte/lib/ImageBrokenIcon';
  import MagnifyingGlassMinusIcon from 'phosphor-svelte/lib/MagnifyingGlassMinusIcon';
  import MagnifyingGlassPlusIcon from 'phosphor-svelte/lib/MagnifyingGlassPlusIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { objectSource } from '#lib/composer/composer-files.js';
  import { i18n } from '#lib/i18n.js';
  import { holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';
  import Switcher from '#lib/ui/primitives/Switcher.svelte';

  import { cropGestures } from './crop-gestures.js';
  import { cropImage } from './crop-image.js';
  import type { CropPreset } from './crop-request.svelte.js';
  import {
    type Corner,
    type Rect,
    type Rotation,
    type Size,
    type View,
    MAX_ZOOM,
    coverScale,
    fitFrame,
    fitView,
    intersect,
    panView,
    resizeFrame,
    rotatedSize,
    sourceRect,
    zoomView,
  } from './geometry.js';

  interface Props {
    file: File;
    preset: CropPreset;
    onDone: (file: File | null) => void;
  }

  let { file, preset, onDone }: Props = $props();

  const INSET = 24;
  const MIN_FRAME = 48;
  const KEY_STEP = 10;
  const KEY_ZOOM = 1.2;

  const PRESETS = {
    avatar: { aspects: ['1:1'], maxEdge: 1024, keepOriginal: true },
    banner: { aspects: ['3:1', 'free'], maxEdge: 2160, keepOriginal: true },
    attachment: {
      aspects: ['original', 'free', '1:1', '16:9'],
      maxEdge: undefined,
      keepOriginal: false,
    },
  } as const;

  const config = $derived(PRESETS[preset]);
  const title = $derived(
    preset === 'avatar'
      ? i18n.t('crop.titleAvatar')
      : preset === 'banner'
        ? i18n.t('crop.titleBanner')
        : i18n.t('crop.titleImage')
  );
  let aspect = $state<string>(untrack(() => PRESETS[preset].aspects[0]));
  let turns = $state(0);
  let rotation = $derived(((((turns % 4) + 4) % 4) * 90) as Rotation);
  let natural = $state.raw<Size | null>(null);
  let stage = $state.raw<Size | null>(null);
  let frame = $state.raw<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  let view = $state.raw<View>({ scale: 1, x: 0, y: 0 });
  let unreadable = $state(false);
  let failed = $state(false);
  let busy = $state(false);
  let dragging = $state(false);
  let resizeFrom: { corner: Corner; frame: Rect } | null = null;

  let image = $derived(natural ? rotatedSize(natural, rotation) : null);
  let zoom = $derived(
    image
      ? Math.min(
          MAX_ZOOM,
          Math.max(1, Math.round((view.scale / coverScale(image, frame)) * 100) / 100)
        )
      : 1
  );
  let ready = $derived(image !== null && stage !== null && frame.width > 0);

  let stageEl: HTMLDivElement | undefined = $state();

  holdOverlayBack(
    () => true,
    () => onDone(null)
  );

  function imageRatio(): number {
    return image ? image.width / image.height : 1;
  }

  function ratioFor(key: string): number {
    if (key === 'original') return imageRatio();
    if (key === 'free') return frame.width > 0 ? frame.width / frame.height : imageRatio();
    const [width, height] = key.split(':').map(Number);
    return width / height;
  }

  function layout(ratio = ratioFor(aspect)): void {
    if (!image || !stage) return;
    frame = fitFrame(stage, ratio, INSET);
    view = fitView(image, frame);
  }

  function setAspect(key: string): void {
    aspect = key;
    if (key !== 'free') layout();
  }

  function rotate(direction: 1 | -1): void {
    turns += direction;
    layout(aspect === 'free' ? imageRatio() : undefined);
  }

  function zoomTo(scale: number, anchor = frameCenter()): void {
    if (image) view = zoomView(view, image, frame, scale, anchor);
  }

  function frameCenter(): { x: number; y: number } {
    return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  }

  const trackStage: Attachment<HTMLDivElement> = (node) => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      stage = { width, height };
      layout();
    });
    observer.observe(node);
    return () => observer.disconnect();
  };

  const gestures = cropGestures({
    enabled: () => ready,
    pan: (dx, dy) => {
      if (image) view = panView(view, image, frame, dx, dy);
    },
    zoom: (factor, anchor) => zoomTo(view.scale * factor, anchor),
    startResize: (corner) => {
      resizeFrom = { corner, frame };
    },
    resize: (dx, dy) => {
      if (!image || !stage || !resizeFrom) return;
      const bounds = intersect(
        { x: INSET, y: INSET, width: stage.width - INSET * 2, height: stage.height - INSET * 2 },
        { x: view.x, y: view.y, width: image.width * view.scale, height: image.height * view.scale }
      );
      frame = resizeFrame(resizeFrom.frame, resizeFrom.corner, dx, dy, bounds, MIN_FRAME);
    },
    active: (active) => {
      dragging = active;
    },
  });

  function loaded(event: Event): void {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget as HTMLImageElement;
    if (width === 0 || height === 0) {
      unreadable = true;
      return;
    }
    natural = { width, height };
    layout();
  }

  function keydown(event: KeyboardEvent): void {
    if (!image) return;
    const step = event.shiftKey ? KEY_STEP * 5 : KEY_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) view = panView(view, image, frame, move[0], move[1]);
    else if (event.key === '+' || event.key === '=') zoomTo(view.scale * KEY_ZOOM);
    else if (event.key === '-') zoomTo(view.scale / KEY_ZOOM);
    else if (event.key === '0') view = fitView(image, frame);
    else if (event.key === 'r') rotate(1);
    else if (event.key === 'R') rotate(-1);
    // eslint-disable-next-line no-restricted-syntax -- not a text input
    else if (event.key === 'Enter') void apply();
    else return;
    event.preventDefault();
  }

  async function apply(): Promise<void> {
    if (!ready || busy) return;
    busy = true;
    failed = false;
    try {
      onDone(
        await cropImage(file, { rect: sourceRect(view, frame), rotation, maxEdge: config.maxEdge })
      );
    } catch (error) {
      console.warn('[sable media] the image could not be cropped', error);
      failed = true;
      busy = false;
    }
  }

  function aspectLabel(key: string): string {
    if (key === 'original') return i18n.t('crop.original');
    if (key === 'free') return i18n.t('crop.free');
    return key;
  }
</script>

<Dialog.Root
  open
  onOpenChange={(open: boolean) => {
    if (!open) onDone(null);
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-backdrop" {...overlayLayer()} />
    <Dialog.Content
      class="dialog-content crop-dialog"
      {...overlayLayer()}
      aria-label={title}
      onOpenAutoFocus={(event: Event) => {
        event.preventDefault();
        stageEl?.focus();
      }}
    >
      <header class="crop-bar">
        <Dialog.Title class="crop-title">{title}</Dialog.Title>
        <IconButton label={i18n.t('common.close')} variant="ghost" onclick={() => onDone(null)}>
          <XIcon />
        </IconButton>
      </header>

      <!-- Dragging, pinching and the wheel duplicate the keyboard handling and the zoom slider. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={stageEl}
        {@attach trackStage}
        {@attach gestures}
        class={['crop-stage', { dragging }]}
        role="application"
        tabindex="0"
        aria-label={i18n.t('crop.stage')}
        onkeydown={keydown}
        ondblclick={() => {
          if (image) view = fitView(image, frame);
        }}
      >
        {#if unreadable}
          <p class="crop-unreadable">
            <ImageBrokenIcon aria-hidden="true" />
            {i18n.t('crop.unreadable')}
          </p>
        {:else}
          <img
            class={['crop-image', { ready }]}
            alt=""
            draggable="false"
            style:width={natural ? `${String(natural.width)}px` : undefined}
            style:height={natural ? `${String(natural.height)}px` : undefined}
            style:transform={natural && image
              ? `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.scale)}) translate(${String(image.width / 2)}px, ${String(image.height / 2)}px) rotate(${String(turns * 90)}deg) translate(${String(-natural.width / 2)}px, ${String(-natural.height / 2)}px)`
              : undefined}
            onload={loaded}
            onerror={() => (unreadable = true)}
            {@attach objectSource(file)}
          />
          {#if ready}
            <div
              class={['crop-frame', { 'crop-frame-avatar': preset === 'avatar' }]}
              style:translate={`${String(frame.x)}px ${String(frame.y)}px`}
              style:width={`${String(frame.width)}px`}
              style:height={`${String(frame.height)}px`}
              aria-hidden="true"
            >
              <span class="crop-grid"></span>
              {#if aspect === 'free'}
                {#each ['nw', 'ne', 'sw', 'se'] as const as corner (corner)}
                  <span class="crop-handle crop-handle-{corner}" data-corner={corner}></span>
                {/each}
              {/if}
            </div>
          {/if}
        {/if}
      </div>

      <div class="crop-controls">
        <div class="crop-zoom">
          <MagnifyingGlassMinusIcon aria-hidden="true" />
          <Slider
            label={i18n.t('crop.zoom')}
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            disabled={!ready}
            value={zoom}
            oninput={(value) => {
              if (image && value !== zoom) zoomTo(value * coverScale(image, frame));
            }}
          />
          <MagnifyingGlassPlusIcon aria-hidden="true" />
        </div>
        <IconButton
          label={i18n.t('crop.rotateLeft')}
          variant="ghost"
          disabled={!ready}
          onclick={() => rotate(-1)}
        >
          <ArrowCounterClockwiseIcon />
        </IconButton>
        <IconButton
          label={i18n.t('crop.rotateRight')}
          variant="ghost"
          disabled={!ready}
          onclick={() => rotate(1)}
        >
          <ArrowClockwiseIcon />
        </IconButton>
        {#if config.aspects.length > 1}
          <Switcher
            label={i18n.t('crop.aspect')}
            items={config.aspects.map((key) => ({ value: key, label: aspectLabel(key) }))}
            value={aspect}
            disabled={!ready}
            onValueChange={setAspect}
          />
        {/if}
      </div>

      {#if failed}
        <p class="crop-error" role="alert">{i18n.t('crop.failed')}</p>
      {/if}

      <footer class="crop-actions">
        {#if config.keepOriginal}
          <Button variant="ghost" class="crop-keep" disabled={busy} onclick={() => onDone(file)}>
            {i18n.t('crop.useOriginal')}
          </Button>
        {/if}
        <Button variant="secondary" disabled={busy} onclick={() => onDone(null)}>
          {i18n.t('common.cancel')}
        </Button>
        <Button variant="primary" loading={busy} disabled={!ready} onclick={() => void apply()}>
          {i18n.t('common.apply')}
        </Button>
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.crop-dialog) {
    background: var(--surface-var-container);
    box-sizing: border-box;
    color: var(--surface-var-on-container);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto auto auto;
    inset: 0;
    overscroll-behavior: contain;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    position: fixed;
  }

  @media (--app-layout) {
    :global(.crop-dialog) {
      border: var(--border-width) solid var(--surface-container-line);
      border-radius: var(--radius);
      box-shadow: var(--shadow-dialog);
      height: min(46rem, calc(100dvh - 3rem));
      inset-inline-start: auto;
      /* stylelint-disable-next-line csstools/use-logical -- centred, so the same in both directions */
      left: 50%;
      overflow: hidden;
      padding: 0;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(56rem, calc(100vw - 3rem));
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on']) .crop-dialog[data-state='open']) {
      animation: crop-in var(--duration-fast) var(--ease-smooth-out);
    }
  }

  @keyframes crop-in {
    from {
      opacity: 0;
    }
  }

  .crop-bar {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    padding: var(--space-200) var(--space-300) var(--space-200) var(--space-400);
  }

  :global(.crop-title) {
    flex: 1;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-600);
    margin: 0;
  }

  .crop-stage {
    cursor: grab;
    overflow: hidden;
    position: relative;
    touch-action: none;
    user-select: none;
  }

  .crop-stage.dragging {
    cursor: grabbing;
  }

  .crop-stage:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .crop-image {
    inset-block-start: 0;
    /* stylelint-disable-next-line csstools/use-logical -- the transform is physical */
    left: 0;
    max-width: none;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    transform-origin: 0 0;
  }

  .crop-image.ready {
    opacity: 1;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .crop-stage:not(.dragging) .crop-image {
      transition:
        transform var(--duration-fast) var(--ease-smooth-out),
        opacity var(--duration-fast) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on'])) .crop-stage:not(.dragging) .crop-frame {
      transition:
        translate var(--duration-fast) var(--ease-smooth-out),
        width var(--duration-fast) var(--ease-smooth-out),
        height var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .crop-frame {
    --crop-line: color-mix(in srgb, white 45%, transparent);

    box-shadow: 0 0 0 100vmax color-mix(in srgb, black 60%, transparent);
    inset-block-start: 0;
    /* stylelint-disable-next-line csstools/use-logical -- placed with a physical translate */
    left: 0;
    outline: var(--border-width) solid color-mix(in srgb, white 85%, transparent);
    pointer-events: none;
    position: absolute;
  }

  .crop-frame-avatar {
    border-radius: 19%;
  }

  .crop-grid {
    background-image:
      linear-gradient(to right, var(--crop-line) 1px, transparent 1px),
      linear-gradient(to bottom, var(--crop-line) 1px, transparent 1px);
    background-size: calc(100% / 3) calc(100% / 3);
    border-radius: inherit;
    inset: 0;
    opacity: 0;
    position: absolute;
  }

  .dragging .crop-grid {
    opacity: 1;
  }

  .crop-handle {
    height: var(--target-hit);
    pointer-events: auto;
    position: absolute;
    touch-action: none;
    width: var(--target-hit);
  }

  .crop-handle::after {
    border: 0 solid white;
    content: '';
    height: var(--space-400);
    position: absolute;
    width: var(--space-400);
  }

  .crop-handle-nw {
    cursor: nwse-resize;
    inset-block-start: calc(var(--target-hit) / -2);
    /* stylelint-disable-next-line csstools/use-logical -- matches the physical frame */
    left: calc(var(--target-hit) / -2);
  }

  .crop-handle-ne {
    cursor: nesw-resize;
    inset-block-start: calc(var(--target-hit) / -2);
    /* stylelint-disable-next-line csstools/use-logical -- matches the physical frame */
    right: calc(var(--target-hit) / -2);
  }

  .crop-handle-sw {
    bottom: calc(var(--target-hit) / -2);
    cursor: nesw-resize;
    /* stylelint-disable-next-line csstools/use-logical -- matches the physical frame */
    left: calc(var(--target-hit) / -2);
  }

  .crop-handle-se {
    bottom: calc(var(--target-hit) / -2);
    cursor: nwse-resize;
    /* stylelint-disable-next-line csstools/use-logical -- matches the physical frame */
    right: calc(var(--target-hit) / -2);
  }

  /* stylelint-disable csstools/use-logical -- corner marks follow the physical frame */
  .crop-handle-nw::after {
    border-left-width: 3px;
    border-top-width: 3px;
    left: 50%;
    top: 50%;
  }

  .crop-handle-ne::after {
    border-right-width: 3px;
    border-top-width: 3px;
    right: 50%;
    top: 50%;
  }

  .crop-handle-sw::after {
    border-bottom-width: 3px;
    border-left-width: 3px;
    bottom: 50%;
    left: 50%;
  }

  .crop-handle-se::after {
    border-bottom-width: 3px;
    border-right-width: 3px;
    bottom: 50%;
    right: 50%;
  }
  /* stylelint-enable csstools/use-logical */

  .crop-unreadable {
    display: grid;
    gap: var(--space-200);
    height: 100%;
    margin: 0;
    padding: var(--space-400);
    place-content: center;
    place-items: center;
    text-align: center;
  }

  .crop-unreadable :global(svg) {
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .crop-controls {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200) var(--space-300);
    justify-content: center;
    padding: var(--space-300) var(--space-400) 0;
  }

  .crop-zoom {
    align-items: center;
    display: flex;
    flex: 1 1 14rem;
    gap: var(--space-200);
    max-width: 22rem;
  }

  .crop-zoom :global(svg) {
    flex: none;
    height: var(--icon-size-small);
    opacity: var(--opacity-secondary);
    width: var(--icon-size-small);
  }

  .crop-error {
    color: var(--crit-main);
    margin: 0;
    padding: var(--space-200) var(--space-400) 0;
    text-align: center;
  }

  .crop-actions {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
    padding: var(--space-300) var(--space-400) var(--space-400);
  }

  .crop-actions :global(.crop-keep) {
    margin-inline-end: auto;
  }
</style>
