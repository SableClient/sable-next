<script lang="ts">
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';

  const MAX_HIGHLIGHT_CHARS = 100_000;
  const PREVIEW_LINES = 12;
  const PREVIEW_CHARS = 2000;

  interface Props {
    src: string;
    name: string;
    language: string | null;
    onDownload?: (event: MouseEvent) => void;
  }

  let { src, name, language, onDownload }: Props = $props();

  let text = $state<string | null>(null);
  let open = $state(false);
  let copied = $state(false);
  let html = $state<string | null>(null);
  let previewHtml = $state<string | null>(null);

  let preview = $derived(
    text === null ? '' : text.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)
  );
  let truncated = $derived(text !== null && preview.length < text.length);

  $effect(() => {
    let active = true;
    text = null;
    html = null;
    previewHtml = null;

    void fetch(src)
      .then((response) => response.text())
      .then((body) => {
        if (active) text = body;
      })
      .catch((error: unknown) => {
        console.debug('[sable media] the text attachment could not be read', error);
      });

    return () => {
      active = false;
    };
  });

  $effect(() => {
    const source = preview;
    if (source === '') return;

    let active = true;
    void highlight(source).then((painted) => {
      if (active) previewHtml = painted;
    });

    return () => {
      active = false;
    };
  });

  $effect(() => {
    const source = text;
    if (!open || source === null || source.length > MAX_HIGHLIGHT_CHARS) return;

    let active = true;
    void highlight(source).then((painted) => {
      if (active) html = painted;
    });

    return () => {
      active = false;
    };
  });

  async function highlight(source: string): Promise<string | null> {
    if (language === null) return null;
    const { highlightCode } = await import('#lib/features/room/code-highlight.js');
    return highlightCode(source, language);
  }

  function paint(painted: string | null) {
    return (node: HTMLElement) => {
      if (painted !== null) node.innerHTML = painted;
    };
  }

  async function copy(): Promise<void> {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (error) {
      console.debug('[sable media] clipboard unavailable', error);
    }
  }
</script>

{#if text !== null}
  <button
    class="text-preview"
    type="button"
    aria-label={$i18n.t('timeline.openFileNamed', { name })}
    onclick={() => {
      open = true;
    }}
  >
    <pre class="text-preview-body"><code {@attach paint(previewHtml)}>{preview}</code></pre>
    {#if truncated}
      <span class="text-preview-more">{$i18n.t('timeline.openFileMore')}</span>
    {/if}
  </button>
{/if}

<DialogFrame bind:open variant="settings" label={name}>
  <div class="text-viewer">
    <header class="text-viewer-head">
      <IconButton
        label={$i18n.t('timeline.closeFile')}
        size="small"
        variant="ghost"
        onclick={() => {
          open = false;
        }}><ArrowLeftIcon /></IconButton
      >
      <span class="text-viewer-name">{name}</span>
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an object URL for the media bytes, not a route -->
      <LinkButton href={src} download={name} size="small" onclick={onDownload}>
        <DownloadSimpleIcon aria-hidden="true" />
        {$i18n.t('timeline.downloadFile')}
      </LinkButton>
      <Button variant="primary" size="small" onclick={copy}>
        {copied ? $i18n.t('timeline.copied') : $i18n.t('timeline.copyAll')}
      </Button>
    </header>
    <div class="text-viewer-scroll">
      <pre class="text-viewer-body"><code {@attach paint(html)}>{text ?? ''}</code></pre>
    </div>
  </div>
</DialogFrame>

<style>
  .text-preview {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    cursor: pointer;
    display: block;
    margin-top: var(--space-100);
    max-width: 100%;
    overflow: hidden;
    padding: 0;
    text-align: start;
    width: 100%;
  }

  .text-preview:hover {
    border-color: var(--primary-main);
  }

  .text-preview:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .text-preview-body {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    line-height: var(--code-line-height);
    margin: 0;
    max-height: 12rem;
    overflow: hidden;
    padding: var(--space-200);
    white-space: pre;
  }

  .text-preview-more {
    color: var(--surface-var-on-container);
    display: block;
    font-size: var(--font-size-small);
    padding: 0 var(--space-200) var(--space-100);
  }

  .text-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .text-viewer-head {
    align-items: center;
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    flex: none;
    gap: var(--space-200);
    padding: var(--space-200);
  }

  .text-viewer-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .text-viewer-scroll {
    background: var(--surface-container);
    color: var(--surface-on-container);
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .text-viewer-body {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    line-height: var(--code-line-height);
    margin: 0;
    overflow-wrap: anywhere;
    padding: var(--space-500);
    white-space: pre-wrap;
  }
</style>
