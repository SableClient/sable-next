import { parseMatrixLink } from './matrix-link';

const CODE_BLOCK_REGEX = /<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>/gi;
const HREF_REGEX = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>/gi;

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

export function firstPreviewableLink(html: string): string | null {
  const withoutCode = html.replace(CODE_BLOCK_REGEX, '');
  for (const match of withoutCode.matchAll(HREF_REGEX)) {
    const href = decodeEntities(match[1]);
    if (isPreviewable(href)) return href;
  }
  return null;
}
