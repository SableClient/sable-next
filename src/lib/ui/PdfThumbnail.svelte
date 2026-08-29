<script lang="ts">
  import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    src: string;
    name: string;
    width?: number;
    onOpen?: () => void;
  }

  let { src, name, width = 320, onOpen }: Props = $props();

  let canvas = $state<HTMLCanvasElement>();
  let failed = $state(false);
  let ready = $state(false);

  $effect(() => {
    const target = canvas;
    if (!target) return;

    let active = true;
    ready = false;
    failed = false;

    const pdfjsLibPromise = import('pdfjs-dist');
    const loadingTask = pdfjsLibPromise.then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
      return pdfjsLib.getDocument({ url: src });
    });

    void loadingTask
      .then((task) => task.promise)
      .then(async (doc) => {
        if (!active) return;
        const page = await doc.getPage(1);
        if (!active) return;

        const unscaled = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / unscaled.width });
        const context = target.getContext('2d');
        if (!context) return;

        const outputScale = window.devicePixelRatio || 1;
        target.width = Math.floor(viewport.width * outputScale);
        target.height = Math.floor(viewport.height * outputScale);
        target.style.width = `${String(viewport.width)}px`;
        target.style.height = `${String(viewport.height)}px`;

        await page.render({
          canvas: target,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        }).promise;
        if (active) ready = true;
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.warn('[sable pdf] the preview could not be rendered', error);
        failed = true;
      });

    return () => {
      active = false;
      void loadingTask.then((task) => task.destroy());
    };
  });
</script>

{#if !failed}
  <button
    class="pdf-thumbnail"
    class:ready
    type="button"
    onclick={onOpen}
    aria-label={$i18n.t('pdf.openNamed', { name })}
  >
    <canvas bind:this={canvas} class="pdf-thumbnail-canvas"></canvas>
  </button>
{/if}

<style>
  .pdf-thumbnail {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    cursor: pointer;
    display: block;
    margin-top: var(--space-100);
    max-width: 100%;
    overflow: hidden;
    padding: 0;
    visibility: hidden;
  }

  .pdf-thumbnail.ready {
    visibility: visible;
  }

  .pdf-thumbnail:hover {
    border-color: var(--sable-primary-main);
  }

  .pdf-thumbnail:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .pdf-thumbnail-canvas {
    display: block;
    max-width: 100%;
  }
</style>
