<script lang="ts">
  import { on } from 'svelte/events';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { cachedMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';

  import type { MatrixLink } from './matrix-link';
  import { parseMatrixLink } from './matrix-link';
  import { splitVia } from './join-address';
  import { settingsLinkLabel } from './settings-link-label';
  import { parseSettingsLink } from './settings-link';

  interface Props {
    html: string;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { html, onMatrixLink }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

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
      const cached = cachedMediaUrl(core, source, width, height);
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
      linkifyMatrixPermalinks(node);
      for (const anchor of node.querySelectorAll('a')) {
        const link = parseMatrixLink(anchor.href);
        if (link) {
          anchor.dataset.matrixLink = link.kind;
          if (
            link.kind !== 'user' &&
            anchor.textContent.trim() === anchor.getAttribute('href')?.trim()
          ) {
            anchor.textContent = link.roomId;
            void resolveRoomName(link, anchor);
          }
          continue;
        }

        const settings = parseSettingsLink(anchor.href, location.origin);
        if (settings) {
          anchor.dataset.settingsLink = settings.section;
          if (settings.focus !== undefined) anchor.dataset.settingsLinkFocus = settings.focus;
          anchor.textContent = settingsLinkLabel(settings);
          continue;
        }

        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
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
      decorateCodeBlocks(node);
      const maths = node.querySelectorAll<HTMLElement>('[data-mx-maths]');
      if (maths.length > 0) void renderMaths(maths);

      const offClick = on(node, 'click', handleClick);
      const offKeydown = on(node, 'keydown', handleKeydown);
      return () => {
        offClick();
        offKeydown();
      };
    };
  }

  async function resolveRoomName(
    link: Exclude<MatrixLink, { kind: 'user' }>,
    anchor: HTMLAnchorElement
  ) {
    const known = roomList.rooms.find(
      (room) => room.room_id === link.roomId || room.canonical_alias === link.roomId
    );
    const name =
      known?.name ??
      (await core.roomPreview(link.roomId, splitVia(anchor.href).via).then(
        (preview) => preview.name,
        () => null
      ));
    if (name && anchor.isConnected) anchor.textContent = name.startsWith('#') ? name : `#${name}`;
  }

  function linkifyMatrixPermalinks(node: HTMLElement): void {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let text = walker.nextNode();
    while (text) {
      if (!text.parentElement?.closest('a, code')) textNodes.push(text as Text);
      text = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const source = textNode.data;
      const matches = [...source.matchAll(/https?:\/\/matrix\.to\/#\/[^\s<]+/gi)].filter((match) =>
        parseMatrixLink(match[0])
      );
      if (matches.length === 0) continue;

      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        const url = match[0];
        const index = match.index;
        fragment.append(source.slice(offset, index));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.textContent = url;
        fragment.append(anchor);
        offset = index + url.length;
      }
      fragment.append(source.slice(offset));
      textNode.replaceWith(fragment);
    }
  }

  /** Past this many lines a block collapses behind a toggle. */
  const CODE_LINE_LIMIT = 14;

  function codeLanguage(block: HTMLElement): string | null {
    const code = block.querySelector('code');
    const named = [...(code?.classList ?? [])].find((name) => name.startsWith('language-'));
    return named?.slice('language-'.length) || null;
  }

  function decorateCodeBlocks(node: HTMLElement): void {
    for (const block of node.querySelectorAll<HTMLPreElement>('pre')) {
      if (block.dataset.codeHandled !== undefined) continue;
      block.dataset.codeHandled = '';

      const language = codeLanguage(block);
      const long = block.textContent.split('\n').length > CODE_LINE_LIMIT;

      const figure = document.createElement('div');
      figure.className = 'code-block';
      if (long) figure.dataset.collapsed = '';

      const header = document.createElement('div');
      header.className = 'code-head';

      const label = document.createElement('span');
      label.className = 'code-language';
      label.textContent = language ?? $i18n.t('timeline.codeLabel');
      header.append(label);

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'code-action';
      copy.dataset.codeCopy = '';
      copy.textContent = $i18n.t('timeline.copyCode');
      header.append(copy);

      if (long) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'code-action';
        toggle.dataset.codeToggle = '';
        toggle.textContent = $i18n.t('timeline.expandCode');
        header.append(toggle);
      }

      block.replaceWith(figure);
      figure.append(header, block);
      if (language) void paintHighlight(block, language);
    }
  }

  async function paintHighlight(block: HTMLPreElement, language: string): Promise<void> {
    const code = block.querySelector('code');
    const source = code?.textContent;
    if (!code || !source) return;

    const { highlightCode } = await import('./code-highlight');
    const html = await highlightCode(source, language);
    // The row may have scrolled out of the virtualiser while the grammar loaded.
    if (html === null || !code.isConnected) return;
    code.innerHTML = html;
  }

  function handleCodeAction(target: Element): boolean {
    const button = target.closest<HTMLButtonElement>('.code-action');
    const figure = button?.closest<HTMLElement>('.code-block');
    const block = figure?.querySelector('pre');
    if (!button || !figure || !block) return false;

    if (button.dataset.codeToggle !== undefined) {
      const collapsed = figure.dataset.collapsed !== undefined;
      if (collapsed) delete figure.dataset.collapsed;
      else figure.dataset.collapsed = '';
      button.textContent = collapsed
        ? $i18n.t('timeline.collapseCode')
        : $i18n.t('timeline.expandCode');
      return true;
    }

    if (button.dataset.codeCopy === undefined) return false;
    const label = button;
    void navigator.clipboard
      .writeText(block.textContent)
      .then(() => {
        label.textContent = $i18n.t('timeline.copiedCode');
        setTimeout(() => {
          if (label.isConnected) label.textContent = $i18n.t('timeline.copyCode');
        }, 1500);
      })
      .catch((error: unknown) => {
        console.debug('[sable code] clipboard unavailable', error);
      });
    return true;
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
    if (handleCodeAction(target)) {
      event.preventDefault();
      return;
    }
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
  }

  .formatted-body :global([data-plain-body]) {
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

  .formatted-body :global(:last-child) {
    margin-bottom: 0;
  }

  .formatted-body :global(ul),
  .formatted-body :global(ol) {
    margin: var(--space-1) 0;
    padding-inline-start: 1.5rem;
  }

  .formatted-body :global(ol) {
    list-style-position: inside;
    padding-inline-start: var(--space-1);
  }

  .formatted-body :global(a) {
    color: var(--sable-primary-main);
    text-decoration: var(--link-decoration);
  }

  .formatted-body :global(a:hover) {
    text-decoration: underline;
  }

  .formatted-body :global(a[data-matrix-link]),
  .formatted-body :global(a[data-settings-link]) {
    background: var(--sable-sec-container);
    border: var(--border-width) solid var(--sable-sec-container-line);
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
    border-left: calc(var(--border-width) * 2) solid var(--sable-primary-main);
    margin: var(--space-compact) 0;
    padding-left: var(--space-1);
  }

  /* Inline code had no rule at all, so it read as prose. */
  .formatted-body :global(:not(pre) > code) {
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: 0.25rem;
    font-family: var(--font-family-mono);
    font-size: 0.9em;
    padding: 0 0.25rem;
  }

  .formatted-body :global(.code-block) {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    margin: var(--space-compact) 0;
    overflow: hidden;
    position: relative;
  }

  .formatted-body :global(.code-head) {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    gap: var(--space-1);
    min-height: var(--control-height-small);
    padding: 0 var(--space-1);
  }

  .formatted-body :global(.code-language) {
    color: var(--sable-surface-var-on-container);
    flex: 1;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .formatted-body :global(.code-action) {
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--sable-primary-main);
    cursor: pointer;
    flex: 0 0 auto;
    font: inherit;
    font-size: var(--font-size-small);
    padding: 0 var(--space-1);
  }

  .formatted-body :global(.code-action:hover) {
    background: var(--sable-surface-container-hover);
  }

  /* Only long lines scroll. A vertical scroller here would swallow the wheel
     whenever the pointer crossed a code block, stalling the timeline. */
  .formatted-body :global(pre) {
    line-height: var(--code-line-height);
    margin: 0;
    overflow: auto hidden;
    overscroll-behavior-x: contain;
    padding: var(--space-1);
  }

  .formatted-body :global(pre code) {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
  }

  /* Bounded so a long paste cannot own the viewport, and so the virtualiser's
     estimate for the row stays close. */
  .formatted-body :global(.code-block[data-collapsed] pre) {
    max-height: 18.75rem;
  }

  .formatted-body :global(.code-block[data-collapsed])::after {
    background: linear-gradient(transparent, var(--sable-surface-container));
    bottom: 0;
    content: '';
    height: 2rem;
    inset-inline: 0;
    pointer-events: none;
    position: absolute;
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
    border: var(--border-width) solid var(--sable-surface-container-line);
    padding: calc(var(--space-compact) / 2) var(--space-tight);
    text-align: left;
  }

  .formatted-body :global(summary) {
    cursor: pointer;
  }
</style>
