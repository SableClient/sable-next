const allowedTags = new Set([
  'A',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DEL',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'OL',
  'P',
  'PRE',
  'STRONG',
  'UL',
]);

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (character) => {
    return entities[character] ?? character;
  });
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'matrix:') return parseMatrixLink(value) ? value : null;
    return ['http:', 'https:'].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function makeLink(document: Document, href: string): HTMLAnchorElement | Text {
  if (!safeHref(href)) return document.createTextNode(href);
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noreferrer noopener';
  link.target = '_blank';
  link.textContent = href;
  return link;
}

function linkifyText(document: Document): void {
  const matcher = /(?:https?:\/\/[^\s<]+|matrix:(?:\/\/)?[^\s<]+)/giu;
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('a, code, pre')) continue;
    textNodes.push(node as Text);
  }

  for (const node of textNodes) {
    const matches = [...node.data.matchAll(matcher)];
    if (matches.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      const href = match[0];
      const start = match.index;
      fragment.append(node.data.slice(offset, start), makeLink(document, href));
      offset = start + href.length;
    }
    fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  }
}

/** Matrix formatted bodies are untrusted, even when they came from our homeserver. */
export function sanitizeMatrixHtml(value: string): string {
  if (typeof DOMParser === 'undefined') return escapeHtml(value);

  const document = new DOMParser().parseFromString(value, 'text/html');
  for (const element of [...document.body.querySelectorAll('*')]) {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(document.createTextNode(element.textContent));
      continue;
    }

    const href = element.getAttribute('href');
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (element.tagName !== 'A') continue;
    const safe = safeHref(href ?? '');
    if (safe) {
      element.setAttribute('href', safe);
      element.setAttribute('rel', 'noreferrer noopener');
      element.setAttribute('target', '_blank');
    }
  }
  linkifyText(document);
  return document.body.innerHTML;
}

/** Linkifies plain Matrix message text without interpreting it as HTML. */
export function linkifyMatrixText(value: string): string {
  if (typeof DOMParser === 'undefined') return escapeHtml(value);

  const document = new DOMParser().parseFromString('', 'text/html');
  document.body.textContent = value;
  linkifyText(document);
  return document.body.innerHTML;
}
import { parseMatrixLink } from './matrix-link';
