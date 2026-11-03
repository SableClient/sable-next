<script lang="ts">
  import { appName } from '#lib/deployment/brand.js';
  import { i18n } from '#lib/i18n.js';
  import {
    closeWindow,
    minimizeWindow,
    toggleMaximizeWindow,
    watchMaximized,
    type TitleBarKind,
  } from '#lib/platform/window-decorations.js';
  import { trackTitlebarHeight } from '#lib/ui/titlebar-inset.svelte.js';

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
</script>

<div class={['titlebar', kind === 'mac' && 'titlebar-mac']} {@attach trackTitlebarHeight}>
  <div class="drag" data-tauri-drag-region>
    <span class="title">{appName()}</span>
  </div>
  {#if kind === 'desktop'}
    <div class="controls">
      <button
        type="button"
        aria-label={i18n.t('window.minimize')}
        onclick={() => {
          minimizeWindow();
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M1.5 6.5h9" stroke-linecap="square" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? i18n.t('common.restore') : i18n.t('window.maximize')}
        onclick={() => {
          toggleMaximizeWindow();
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
        aria-label={i18n.t('common.close')}
        onclick={() => {
          closeWindow();
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke-linecap="square" />
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .titlebar {
    align-items: stretch;
    background: var(--bg-container);
    border-bottom: var(--border-width) solid var(--bg-container-line);
    display: flex;
    height: var(--titlebar-height);
    inset: 0 0 auto;
    pointer-events: auto;
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

  :global([data-tauri-drag-region]) {
    -webkit-app-region: drag;
  }

  :global(.titlebar .controls) {
    -webkit-app-region: no-drag;
  }
</style>
