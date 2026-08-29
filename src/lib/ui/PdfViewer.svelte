<script lang="ts">
  import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
  import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';

  interface Props {
    src: string;
    name: string;
    page?: number;
    zoom?: number;
    onPages?: (pages: number) => void;
  }

  let { src, name, page = 1, zoom = 1, onPages }: Props = $props();

  let container = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let doc = $state<PDFDocumentProxy | null>(null);
  let numPages = $state(0);
  let containerWidth = $state(0);
  let containerHeight = $state(0);
  let loading = $state(true);
  let failed = $state(false);
  let attempt = $state(0);

  let canvasLabel = $derived($i18n.t('pdf.documentLabel', { name, page, pages: numPages }));

  $effect(() => {
    void attempt;
    let active = true;
    loading = true;
    failed = false;
    doc = null;
    numPages = 0;

    const pdfjsLibPromise = import('pdfjs-dist');
    const loadingTask = pdfjsLibPromise.then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
      return pdfjsLib.getDocument({ url: src });
    });

    void loadingTask
      .then((task) => task.promise)
      .then((loaded) => {
        if (!active) return;
        doc = loaded;
        numPages = loaded.numPages;
        onPages?.(loaded.numPages);
        loading = false;
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.warn('[sable pdf] the document could not be loaded', error);
        failed = true;
        loading = false;
      });

    return () => {
      active = false;
      void loadingTask.then((task) => task.destroy());
    };
  });

  $effect(() => {
    const element = container;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      containerWidth = entry.contentRect.width;
      containerHeight = entry.contentRect.height;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  });

  $effect(() => {
    const activeDoc = doc;
    const target = canvas;
    const width = containerWidth;
    const height = containerHeight;
    const magnification = zoom;
    const pageIndex = page;
    if (!activeDoc || !target || width <= 0) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      const pdfPage = await activeDoc.getPage(pageIndex);
      if (cancelled) return;
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const fit =
        height > 0
          ? Math.min(width / unscaled.width, height / unscaled.height)
          : width / unscaled.width;
      const viewport = pdfPage.getViewport({ scale: fit * magnification });
      const context = target.getContext('2d');
      if (!context) return;

      const outputScale = window.devicePixelRatio || 1;
      target.width = Math.floor(viewport.width * outputScale);
      target.height = Math.floor(viewport.height * outputScale);
      target.style.width = `${String(viewport.width)}px`;
      target.style.height = `${String(viewport.height)}px`;
      const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];

      renderTask = pdfPage.render({ canvas: target, canvasContext: context, viewport, transform });
      try {
        await renderTask.promise;
      } catch (error) {
        if (!cancelled) console.debug('[sable pdf] page render did not complete', error);
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  });

  function retry(): void {
    attempt += 1;
  }
</script>

<div class="pdf-viewer" bind:this={container}>
  <div class="pdf-page-frame">
    {#if loading}
      <Spinner />
    {:else if failed}
      <div class="pdf-error">
        <WarningIcon />
        <p>{$i18n.t('pdf.loadFailed')}</p>
        <Button size="small" onclick={retry}>{$i18n.t('pdf.retry')}</Button>
      </div>
    {:else}
      <div class="pdf-canvas-frame" role="img" aria-label={canvasLabel}>
        <canvas bind:this={canvas} class="pdf-canvas"></canvas>
      </div>
    {/if}
  </div>
</div>

<style>
  .pdf-viewer {
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    height: 100%;
    min-height: 0;
    width: 100%;
  }

  .pdf-page-frame {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    display: flex;
    flex: 1 1 auto;
    justify-content: center;
    min-height: 0;
    overflow: auto;
    width: 100%;
  }

  .pdf-canvas-frame {
    margin: auto;
  }

  .pdf-canvas {
    display: block;
  }

  .pdf-error {
    align-items: center;
    color: var(--sable-surface-on-container);
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200);
    text-align: center;
  }
</style>
