<script lang="ts">
  import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
  import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

  import { i18n } from '#lib/i18n.js';
  import { saveFile, savesNatively } from '#lib/platform/files.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';

  interface Props {
    src: string;
    name: string;
  }

  let { src, name }: Props = $props();

  let container = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let doc = $state<PDFDocumentProxy | null>(null);
  let numPages = $state(0);
  let pageNumber = $state(1);
  let containerWidth = $state(0);
  let loading = $state(true);
  let failed = $state(false);
  let attempt = $state(0);

  let pageLabel = $derived($i18n.t('pdf.pageIndicator', { page: pageNumber, pages: numPages }));
  let canvasLabel = $derived(
    $i18n.t('pdf.documentLabel', { name, page: pageNumber, pages: numPages })
  );

  $effect(() => {
    void attempt;
    let active = true;
    loading = true;
    failed = false;
    doc = null;
    numPages = 0;
    pageNumber = 1;

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
      if (entry) containerWidth = entry.contentRect.width;
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
    const page = pageNumber;
    if (!activeDoc || !target || width <= 0) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      const pdfPage = await activeDoc.getPage(page);
      if (cancelled) return;
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(width / unscaled.width, 2);
      const viewport = pdfPage.getViewport({ scale });
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

  function previousPage(): void {
    pageNumber = Math.max(1, pageNumber - 1);
  }

  function nextPage(): void {
    pageNumber = Math.min(numPages, pageNumber + 1);
  }

  function retry(): void {
    attempt += 1;
  }

  async function download(): Promise<void> {
    if (savesNatively()) {
      await saveFile(src, name);
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = name;
    anchor.click();
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
  {#if !loading && !failed && numPages > 0}
    <div class="pdf-controls">
      <IconButton
        label={$i18n.t('pdf.previousPage')}
        size="medium"
        variant="ghost"
        disabled={pageNumber <= 1}
        onclick={previousPage}><CaretLeftIcon /></IconButton
      >
      <span class="pdf-page-indicator" aria-live="polite">{pageLabel}</span>
      <IconButton
        label={$i18n.t('pdf.nextPage')}
        size="medium"
        variant="ghost"
        disabled={pageNumber >= numPages}
        onclick={nextPage}><CaretRightIcon /></IconButton
      >
      <IconButton
        label={$i18n.t('pdf.download')}
        size="medium"
        variant="ghost"
        onclick={() => void download()}><DownloadSimpleIcon /></IconButton
      >
    </div>
  {/if}
</div>

<style>
  .pdf-viewer {
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    max-width: var(--timeline-media-max);
    width: 100%;
  }

  .pdf-page-frame {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    display: flex;
    justify-content: center;
    max-height: 24rem;
    min-height: 8rem;
    overflow: auto;
    width: 100%;
  }

  .pdf-canvas {
    display: block;
    max-width: 100%;
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

  .pdf-controls {
    align-items: center;
    display: flex;
    gap: var(--space-100);
    justify-content: center;
  }

  .pdf-page-indicator {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    min-width: 5rem;
    text-align: center;
  }

  @media (width >= 48rem) {
    .pdf-page-frame {
      max-height: 32rem;
    }
  }
</style>
