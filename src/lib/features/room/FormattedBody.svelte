<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { cachedMediaUrl, loadMediaUrl } from '$lib/ui/media-url';

  import type { MatrixLink } from './matrix-link';
  import { parseMatrixLink } from './matrix-link';

  interface Props {
    html: string;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { html, onMatrixLink }: Props = $props();
  const core = useCoreClient();

  function resolveImages(node: HTMLElement): void {
    for (const image of node.querySelectorAll('img')) {
      if (image.dataset.mediaHandled !== undefined) continue;
      image.dataset.mediaHandled = '';

      const source = image.getAttribute('src') ?? '';
      const emoticon = image.dataset.mxEmoticon !== undefined;
      const scheme = source.slice(0, source.indexOf(':') + 1).toLowerCase();
      if (scheme === 'http:' || scheme === 'https:') {
        image.onerror = () => {
          console.warn('[sable media] remote image unavailable', source);
          image.replaceWith(fallbackLabel(image, emoticon));
        };
        image.src = source;
        continue;
      }
      if (scheme !== 'mxc:') {
        image.replaceWith(fallbackLabel(image, emoticon));
        continue;
      }

      const [width, height] = emoticon ? [0, 0] : [640, 480];
      image.dataset.mediaPending = '';
      image.removeAttribute('src');
      const cached = cachedMediaUrl(source, width, height);
      if (cached !== undefined) {
        paint(image, cached);
        continue;
      }
      void loadMediaUrl(core, source, width, height)
        .then((url) => {
          if (image.isConnected) paint(image, url);
        })
        .catch((error: unknown) => {
          console.warn('[sable media] inline image unavailable', source, error);
          if (image.isConnected) image.replaceWith(fallbackLabel(image, emoticon));
        });
    }
  }

  function paint(image: HTMLImageElement, url: string): void {
    image.src = url;
    delete image.dataset.mediaPending;
  }

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
      element.innerHTML = katex.renderToString(maths, {
        displayMode: element.tagName === 'DIV',
        throwOnError: false,
      });
    }
  }

  function decorate(html: string) {
    return (node: HTMLElement) => {
      void html;
      for (const anchor of node.querySelectorAll('a')) {
        const link = parseMatrixLink(anchor.href);
        if (link) anchor.dataset.matrixLink = link.kind;
        else {
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
        }
      }
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

  .formatted-body :global(h1),
  .formatted-body :global(h2),
  .formatted-body :global(h3),
  .formatted-body :global(h4),
  .formatted-body :global(h5),
  .formatted-body :global(h6) {
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-body);
    margin: 0.25rem 0 0;
  }

  .formatted-body :global(h1) {
    font-size: var(--font-size-large);
  }

  .formatted-body :global(h2) {
    font-size: var(--font-size-medium);
  }

  .formatted-body :global(h3),
  .formatted-body :global(h4),
  .formatted-body :global(h5),
  .formatted-body :global(h6) {
    font-size: inherit;
  }

  .formatted-body :global(:first-child) {
    margin-top: 0;
  }

  .formatted-body :global(a) {
    color: var(--sable-primary-main);
    text-decoration: underline;
  }

  .formatted-body :global(a[data-matrix-link]) {
    background: var(--sable-sec-container);
    border: 1px solid var(--sable-sec-container-line);
    border-radius: var(--radius);
    color: var(--sable-sec-on-container);
    display: inline-block;
    font-weight: var(--font-weight-medium);
    padding: 0 var(--space-tight);
    text-decoration: none;
  }

  .formatted-body :global([data-mx-spoiler]:not([aria-pressed='false'])) {
    background: var(--sable-surface-var-on-container);
    border-radius: var(--radius);
    color: transparent;
    cursor: pointer;
  }

  .formatted-body :global([data-mx-spoiler]:not([aria-pressed='false']) *) {
    visibility: hidden;
  }

  .formatted-body :global(blockquote) {
    border-left: 2px solid var(--sable-primary-main);
    margin: var(--space-compact) 0;
    padding-left: var(--space-1);
  }

  .formatted-body :global(pre) {
    overflow-x: auto;
  }

  .formatted-body :global(img[data-media-pending]) {
    display: none;
  }

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
    margin: var(--space-compact) 0;
  }

  .formatted-body :global(th),
  .formatted-body :global(td) {
    border: 1px solid var(--sable-surface-container-line);
    padding: calc(var(--space-compact) / 2) var(--space-tight);
    text-align: left;
  }

  .formatted-body :global(summary) {
    cursor: pointer;
  }
</style>
