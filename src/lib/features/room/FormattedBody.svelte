<script lang="ts">
  import type { MatrixLink } from './matrix-link';
  import { parseMatrixLink } from './matrix-link';
  import { linkifyMatrixText, sanitizeMatrixHtml } from './sanitize-matrix-html';

  interface Props {
    body: string;
    formatted: string | null;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { body, formatted, onMatrixLink }: Props = $props();
  let safeHtml = $derived(
    formatted === null ? linkifyMatrixText(body) : sanitizeMatrixHtml(formatted)
  );
  let root = $state<HTMLDivElement>();

  $effect(() => {
    void safeHtml;
    const container = root;
    if (!container) return;
    for (const anchor of container.querySelectorAll('a')) {
      const link = parseMatrixLink(anchor.href);
      if (link) anchor.dataset.matrixLink = link.kind;
    }
    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
    };
  });

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a');
    if (!anchor) return;
    const link = parseMatrixLink(anchor.href);
    if (!link || !onMatrixLink) return;
    event.preventDefault();
    onMatrixLink(link, anchor);
  }
</script>

<!-- `safeHtml` only comes from the allow-list sanitizer above. -->
<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div bind:this={root} class="formatted-body">{@html safeHtml}</div>

<style>
  .formatted-body,
  .formatted-body :global(p) {
    line-height: var(--line-height-body);
    margin: 0;
    white-space: pre-wrap;
  }

  .formatted-body :global(a) {
    color: var(--sable-primary-main);
    text-decoration: underline;
  }

  .formatted-body :global(a[data-matrix-link]) {
    background: var(--sable-primary-container);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-container);
    display: inline-block;
    padding: 0 0.375rem;
    text-decoration: none;
  }

  .formatted-body :global(blockquote) {
    border-left: 2px solid var(--sable-primary-main);
    margin: 0.25rem 0;
    padding-left: 0.5rem;
  }

  .formatted-body :global(pre) {
    overflow-x: auto;
  }
</style>
