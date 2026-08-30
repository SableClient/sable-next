<script lang="ts">
  import CornersInIcon from 'phosphor-svelte/lib/CornersInIcon';
  import CornersOutIcon from 'phosphor-svelte/lib/CornersOutIcon';
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import {
    closeWindow,
    minimizeWindow,
    startWindowDrag,
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
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="drag"
    data-tauri-drag-region
    ondblclick={() => {
      void toggleMaximizeWindow();
    }}
    onmousedown={(event) => {
      if (event.button === 0 && event.detail === 1) void startWindowDrag();
    }}
  >
    <span class="title">Sable</span>
  </div>
  {#if kind === 'desktop'}
    <div class="controls">
      <button
        type="button"
        aria-label={$i18n.t('window.minimize')}
        onclick={() => {
          void minimizeWindow();
        }}
      >
        <MinusIcon />
      </button>
      <button
        type="button"
        aria-label={maximized ? $i18n.t('window.restore') : $i18n.t('window.maximize')}
        onclick={() => {
          void toggleMaximizeWindow();
        }}
      >
        {#if maximized}<CornersInIcon />{:else}<CornersOutIcon />{/if}
      </button>
      <button
        type="button"
        class="close"
        aria-label={$i18n.t('window.close')}
        onclick={() => {
          void closeWindow();
        }}
      >
        <XIcon />
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
    background: var(--sable-bg-container);
    border-bottom: var(--border-width) solid var(--sable-bg-container-line);
    display: flex;
    height: var(--titlebar-height);
    inset: 0 0 auto;
    position: fixed;
    z-index: 600;
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
    color: var(--sable-surface-var-on-container);
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
    color: var(--sable-bg-on-container);
    cursor: default;
    display: flex;
    justify-content: center;
    padding: 0 var(--space-300);
  }

  .controls button:hover {
    background: var(--sable-bg-container-hover);
  }

  .controls button.close:hover {
    background: var(--sable-crit-main);
    color: var(--sable-crit-on-main);
  }

  .controls :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .handle {
    position: fixed;
    z-index: 601;
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
