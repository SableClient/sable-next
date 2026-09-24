<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import {
    closeWindow,
    dismissSnapLayouts,
    minimizeWindow,
    releaseSnapLayouts,
    showSnapLayouts,
    supportsSnapLayouts,
    startWindowResize,
    toggleMaximizeWindow,
    watchMaximized,
    type TitleBarKind,
    type WindowEdge,
  } from '#lib/platform/window-decorations.js';

  interface Props {
    kind: TitleBarKind;
  }

  let { kind }: Props = $props();
  let maximized = $state(false);

  const SNAP_LAYOUTS_DELAY_MS = 620;
  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  let snapShown = false;

  function snapFailed(error: unknown): void {
    console.debug('[sable window] snap layouts failed', error);
  }

  function hoverMaximize(): void {
    if (kind !== 'desktop' || !supportsSnapLayouts()) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      snapShown = true;
      showSnapLayouts().catch(snapFailed);
    }, SNAP_LAYOUTS_DELAY_MS);
  }

  function endSnap(action: () => Promise<void>): void {
    clearTimeout(snapTimer);
    if (!snapShown) return;
    snapShown = false;
    action().catch(snapFailed);
  }

  const leaveMaximize = (): void => endSnap(releaseSnapLayouts);
  const dismissSnap = (): void => endSnap(dismissSnapLayouts);

  $effect(() => dismissSnap);

  $effect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;

    void watchMaximized((next) => {
      maximized = next;
    })
      .then((unlisten) => {
        stop = unlisten;
        if (cancelled) stop();
      })
      .catch((error: unknown) => {
        console.debug('[sable window] the maximised state is not observable', error);
      });

    return () => {
      cancelled = true;
      stop?.();
    };
  });

  const edges: WindowEdge[] = [
    'North',
    'NorthEast',
    'East',
    'SouthEast',
    'South',
    'SouthWest',
    'West',
    'NorthWest',
  ];
</script>

<div class={['titlebar', kind === 'mac' && 'titlebar-mac']}>
  <div class="drag" data-tauri-drag-region>
    <span class="title">Sable</span>
  </div>
  {#if kind === 'desktop'}
    <div class="controls">
      <button
        type="button"
        aria-label={$i18n.t('window.minimize')}
        onclick={() => {
          dismissSnap();
          void minimizeWindow();
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M1.5 6.5h9" stroke-linecap="square" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? $i18n.t('window.restore') : $i18n.t('window.maximize')}
        onmouseenter={hoverMaximize}
        onmouseleave={leaveMaximize}
        onclick={() => {
          dismissSnap();
          void toggleMaximizeWindow();
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          {#if maximized}
            <rect x="1.5" y="3.5" width="7" height="7" />
            <path d="M3.5 1.5h5a2 2 0 0 1 2 2v5" />
          {:else}
            <rect x="1.5" y="1.5" width="9" height="9" />
          {/if}
        </svg>
      </button>
      <button
        type="button"
        class="close"
        aria-label={$i18n.t('window.close')}
        onclick={() => {
          dismissSnap();
          void closeWindow();
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke-linecap="square" />
        </svg>
      </button>
    </div>
  {/if}
</div>

{#if kind === 'desktop' && !maximized}
  <div class="resize-handles" aria-hidden="true">
    {#each edges as edge (edge)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="handle handle-{edge.toLowerCase()}"
        onmousedown={(event) => {
          if (event.button === 0) void startWindowResize(edge);
        }}
      ></div>
    {/each}
  </div>
{/if}

<style>
  .titlebar {
    align-items: stretch;
    background: var(--bg-container);
    border-bottom: var(--border-width) solid var(--bg-container-line);
    display: flex;
    height: var(--titlebar-height);
    inset: 0 0 auto;
    position: fixed;
    user-select: none;
    z-index: var(--layer-chrome);
  }

  .drag {
    align-items: center;
    display: flex;
    flex: 1;
    min-width: 0;
    padding-inline: var(--space-300);
  }

  .titlebar-mac .drag {
    padding-inline: var(--mac-traffic-lights) var(--space-300);
  }

  .title {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow: hidden;
    pointer-events: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .controls {
    display: flex;
    flex: 0 0 auto;
  }

  .controls button {
    align-items: center;
    background: none;
    border: 0;
    color: var(--bg-on-container);
    cursor: default;
    display: flex;
    justify-content: center;
    padding: 0;
    width: 46px;
  }

  .controls button:hover {
    background: var(--bg-container-hover);
  }

  .controls button.close:hover {
    background: var(--crit-main);
    color: var(--crit-on-main);
  }

  .controls svg {
    fill: none;
    height: 12px;
    shape-rendering: crispedges;
    stroke: currentcolor;
    stroke-width: 1;
    width: 12px;
  }

  .controls svg * {
    vector-effect: non-scaling-stroke;
  }

  .handle {
    position: fixed;
    z-index: calc(var(--layer-chrome) + 1);
  }

  :global([data-tauri-drag-region]) {
    -webkit-app-region: drag;
  }

  :global(.titlebar .controls) {
    -webkit-app-region: no-drag;
  }

  .handle-north,
  .handle-south {
    height: var(--resize-handle);
    inset-inline: var(--resize-handle) var(--resize-handle);
  }

  .handle-north {
    cursor: ns-resize;
    top: 0;
  }

  .handle-south {
    bottom: 0;
    cursor: ns-resize;
  }

  .handle-east,
  .handle-west {
    inset-block: var(--resize-handle) var(--resize-handle);
    width: var(--resize-handle);
  }

  .handle-east {
    cursor: ew-resize;
    right: 0;
  }

  .handle-west {
    cursor: ew-resize;
    left: 0;
  }

  .handle-northwest,
  .handle-northeast,
  .handle-southwest,
  .handle-southeast {
    height: var(--resize-handle);
    width: var(--resize-handle);
  }

  .handle-northwest {
    cursor: nwse-resize;
    left: 0;
    top: 0;
  }

  .handle-northeast {
    cursor: nesw-resize;
    right: 0;
    top: 0;
  }

  .handle-southwest {
    bottom: 0;
    cursor: nesw-resize;
    left: 0;
  }

  .handle-southeast {
    bottom: 0;
    cursor: nwse-resize;
    right: 0;
  }
</style>
