import { parseMatrixLink } from './matrix-link';

const TAG_REGEX = /<(\/?)([a-z0-9-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gi;
const HREF_REGEX = /\bhref\s*=\s*"([^"]*)"/i;

const VERBATIM_ELEMENTS = new Set(['pre', 'code']);

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

function isPreviewable(href: string): boolean {
  if (parseMatrixLink(href)) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hidesItsLinks(name: string, attributes: string): boolean {
  return (
    VERBATIM_ELEMENTS.has(name) || (name === 'span' && /\bdata-mx-spoiler\b/i.test(attributes))
  );
}

export function firstPreviewableLink(html: string): string | null {
  let skipped: { name: string; depth: number } | null = null;

  for (const [, closing, rawName, attributes = '', slash] of html.matchAll(TAG_REGEX)) {
    const name = rawName.toLowerCase();
    const opens = closing === '' && slash === '';

    if (skipped !== null) {
      if (name !== skipped.name) continue;
      if (opens) skipped.depth += 1;
      else if (closing !== '' && --skipped.depth === 0) skipped = null;
      continue;
    }

    if (opens && hidesItsLinks(name, attributes)) {
      skipped = { name, depth: 1 };
      continue;
    }
    if (!opens || name !== 'a') continue;

    const href = HREF_REGEX.exec(attributes)?.[1];
    if (href === undefined) continue;
    const decoded = decodeEntities(href);
    if (isPreviewable(decoded)) return decoded;
  }

  return null;
}
