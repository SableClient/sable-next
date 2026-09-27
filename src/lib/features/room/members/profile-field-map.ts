import { parseJsonObject } from '#lib/json-object.js';

const PREVIEW_CHARS = 256;
const graphemes = new Intl.Segmenter();

export function profileFieldPreview(value: string): string {
  return Array.from(graphemes.segment(value), ({ segment }) => segment)
    .slice(0, PREVIEW_CHARS)
    .join('');
}

export function profileFieldJson(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  return typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed, null, 2) : value;
}

export function profileFieldMap(value: string): [string, string][] | null {
  const parsed = parseJsonObject(value);
  if (!parsed) return null;

  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;

  const map: [string, string][] = [];
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      return null;
    }
    map.push([key, String(entry)]);
  }
  return map;
}
