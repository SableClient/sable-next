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
    return ['http:', 'https:', 'matrix:'].includes(url.protocol) ? value : null;
  } catch {
    return null;
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
    }
  }
  return document.body.innerHTML;
}
