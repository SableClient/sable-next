import { parseJsonObject } from '#lib/json-object.js';

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
