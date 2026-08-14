<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { cachedMediaUrl, loadMediaUrl } from '$lib/ui/media-url';

  import type { MatrixLink } from './matrix-link';
  import { parseMatrixLink } from './matrix-link';

  interface Props {
    /** Display HTML from the core, already sanitised. */
    html: string;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { html, onMatrixLink }: Props = $props();
  const core = useCoreClient();

  function resolveImages(node: HTMLElement): void {
    for (const image of node.querySelectorAll<HTMLImageElement>('img[src^="mxc://"]')) {
      const source = image.getAttribute('src') ?? '';
      const emoticon = image.dataset.mxEmoticon !== undefined;
      // Emoji are small enough to take whole; anything else is scaled down.
      const [width, height] = emoticon ? [0, 0] : [640, 480];
      const cached = cachedMediaUrl(source, width, height);
      if (cached !== undefined) {
        image.src = cached;
        continue;
      }
      void loadMediaUrl(core, source, width, height)
        .then((url) => {
          if (image.isConnected) image.src = url;
        })
        .catch(() => {
          if (image.isConnected) image.replaceWith(fallbackLabel(image, emoticon));
        });
    }
  }

  /** An unresolvable emoji reads better as its shortcode than as nothing. */
  function fallbackLabel(image: HTMLImageElement, emoticon: boolean): string {
    const label = image.alt || image.title;
    if (!label) return '';
    return emoticon ? `:${label}:` : label;
  }

  async function renderMaths(elements: NodeListOf<HTMLElement>): Promise<void> {
    const [{ default: katex }] = await Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]);
    for (const element of elements) {
      const maths = element.dataset.mxMaths;
      if (maths === undefined || !element.isConnected) continue;
      // Replaces the sender's fallback text, which is what the element holds.
      element.innerHTML = katex.renderToString(maths, {
        displayMode: element.tagName === 'DIV',
        throwOnError: false,
      });
    }
  }

  /** Reading `html` is what makes a new body re-run the pass over its nodes. */
  function decorate(html: string) {
    return (node: HTMLElement) => {
      void html;
      for (const anchor of node.querySelectorAll('a')) {
        const link = parseMatrixLink(anchor.href);
        if (link) anchor.dataset.matrixLink = link.kind;
        else anchor.target = '_blank';
      }
      // The core keeps colours as data attributes so its allow-list never has
      // to admit `style`.
      for (const element of node.querySelectorAll<HTMLElement>('[data-mx-color]')) {
        element.style.color = element.dataset.mxColor ?? '';
      }
      for (const element of node.querySelectorAll<HTMLElement>('[data-mx-bg-color]')) {
        element.style.backgroundColor = element.dataset.mxBgColor ?? '';
      }
      for (const element of node.querySelectorAll<HTMLElement>('[data-mx-spoiler]')) {
        element.tabIndex = 0;
        element.role = 'button';
        element.ariaPressed = 'true';
      }

      resolveImages(node);
      const maths = node.querySelectorAll<HTMLElement>('[data-mx-maths]');
      if (maths.length > 0) void renderMaths(maths);

      node.addEventListener('click', handleClick);
      node.addEventListener('keydown', handleKeydown);
      return () => {
        node.removeEventListener('click', handleClick);
        node.removeEventListener('keydown', handleKeydown);
      };
    };
  }

  function reveal(target: Element): boolean {
    const spoiler = target.closest<HTMLElement>('[data-mx-spoiler]');
    if (!spoiler || spoiler.ariaPressed === 'false') return false;
    spoiler.ariaPressed = 'false';
    return true;
  }

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (reveal(target)) {
      event.preventDefault();
      return;
    }

    const anchor = target.closest<HTMLAnchorElement>('a');
    if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const link = parseMatrixLink(anchor.href);
    if (!link || !onMatrixLink) return;
    event.preventDefault();
    onMatrixLink(link, anchor);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof Element) || !target.matches('[data-mx-spoiler]')) return;
    if (reveal(target)) event.preventDefault();
  }
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div class="formatted-body" {@attach decorate(html)}>{@html html}</div>

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

  /* Hidden from the first paint: the attachment only adds the toggle state. */
  .formatted-body :global([data-mx-spoiler]:not([aria-pressed='false'])) {
    background: var(--sable-surface-var-on-container);
    border-radius: var(--radius);
    color: transparent;
    cursor: pointer;
  }

  /* A nested link keeps its own colour, so the subtree has to be hidden too. */
  .formatted-body :global([data-mx-spoiler]:not([aria-pressed='false']) *) {
    visibility: hidden;
  }

  .formatted-body :global(blockquote) {
    border-left: 2px solid var(--sable-primary-main);
    margin: 0.25rem 0;
    padding-left: 0.5rem;
  }

  .formatted-body :global(pre) {
    overflow-x: auto;
  }

  /* Still an `mxc:` URI, so the browser has nothing to load yet. */
  .formatted-body :global(img[src^='mxc://']) {
    display: none;
  }

  /* No `height` here, so the sender's attribute still sets the size under the cap. */
  .formatted-body :global(img) {
    max-height: 4rem;
    max-width: 100%;
    vertical-align: middle;
    width: auto;
  }

  .formatted-body :global(img[data-mx-emoticon]) {
    height: 1em;
  }

  .formatted-body :global(table) {
    border-collapse: collapse;
    margin: 0.25rem 0;
  }

  .formatted-body :global(th),
  .formatted-body :global(td) {
    border: 1px solid var(--sable-surface-container-line);
    padding: 0.125rem 0.375rem;
    text-align: left;
  }

  .formatted-body :global(summary) {
    cursor: pointer;
  }
</style>
