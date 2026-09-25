import { isRecord } from '#lib/guards.js';
import {
  MAX_THEME_FILE_BYTES,
  themeFileMetadata,
  themeSwatches,
  type ThemeFileMetadata,
} from '#lib/settings/theme-file.js';

export const CATALOG_URL = 'https://raw.githubusercontent.com/SableClient/themes/main/catalog.json';
const CATALOG_FILES = 'https://raw.githubusercontent.com/SableClient/themes/';
const DESCRIBE_CONCURRENCY = 6;

interface CatalogRow {
  basename: string;
  previewUrl: string | null;
  fullUrl: string;
}

export interface CatalogEntry {
  kind: 'theme' | 'tweak';
  basename: string;
  fullUrl: string;
  meta: ThemeFileMetadata;
  swatches: string[];
}

export interface CatalogFilter {
  query: string;
  kind: 'all' | 'light' | 'dark';
  highContrast: boolean;
}

export function catalogFileUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const href = url.href;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return href.startsWith(CATALOG_FILES) && !href.includes('/../') ? href : null;
}

function rows(value: unknown): CatalogRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!isRecord(row) || typeof row.basename !== 'string') return [];
    const fullUrl = catalogFileUrl(row.fullUrl);
    if (fullUrl === null) return [];
    return [
      { basename: row.basename.slice(0, 128), previewUrl: catalogFileUrl(row.previewUrl), fullUrl },
    ];
  });
}

export async function fetchCatalogFile(url: string): Promise<string> {
  const safe = catalogFileUrl(url);
  if (safe === null) throw new Error('catalog file outside the catalog');
  const response = await fetch(safe, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`catalog file answered ${String(response.status)}`);
  const css = await response.text();
  if (css.length > MAX_THEME_FILE_BYTES) throw new Error('catalog file too large');
  return css;
}

export async function fetchCatalog(): Promise<{ themes: CatalogRow[]; tweaks: CatalogRow[] }> {
  const response = await fetch(CATALOG_URL, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`catalog answered ${String(response.status)}`);
  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.themes)) throw new Error('catalog unreadable');
  return { themes: rows(data.themes), tweaks: rows(data.tweaks) };
}

async function describe(kind: CatalogEntry['kind'], row: CatalogRow): Promise<CatalogEntry> {
  const css = await fetchCatalogFile(row.previewUrl ?? row.fullUrl).catch(() => '');
  return {
    kind,
    basename: row.basename,
    fullUrl: row.fullUrl,
    meta: themeFileMetadata(css),
    swatches: themeSwatches(css),
  };
}

export async function describeCatalog(
  kind: CatalogEntry['kind'],
  catalogRows: readonly CatalogRow[],
  onEntry: (entry: CatalogEntry) => void
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < catalogRows.length) {
      const row = catalogRows[next];
      next += 1;
      try {
        onEntry(await describe(kind, row));
      } catch (error) {
        console.debug('[sable themes] catalog entry unavailable', row.basename, error);
      }
    }
  };
  await Promise.all(Array.from({ length: DESCRIBE_CONCURRENCY }, worker));
}

let loaded: CatalogEntry[] | null = null;

export async function loadCatalog(onEntry: (entry: CatalogEntry) => void): Promise<void> {
  if (loaded) {
    for (const entry of loaded) onEntry(entry);
    return;
  }
  const catalog = await fetchCatalog();
  const found: CatalogEntry[] = [];
  const collect = (entry: CatalogEntry): void => {
    found.push(entry);
    onEntry(entry);
  };
  await Promise.all([
    describeCatalog('theme', catalog.themes, collect),
    describeCatalog('tweak', catalog.tweaks, collect),
  ]);
  loaded = found;
}

export function entryName(entry: CatalogEntry): string {
  return entry.meta.name ?? entry.basename;
}

export function filterCatalog(
  entries: readonly CatalogEntry[],
  filter: CatalogFilter
): CatalogEntry[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => {
      if (entry.kind === 'theme') {
        if (filter.kind !== 'all' && entry.meta.kind !== filter.kind) return false;
        if (filter.highContrast && entry.meta.contrast !== 'high') return false;
      }
      if (query === '') return true;
      return [entryName(entry), entry.meta.author, entry.meta.description, ...entry.meta.tags]
        .filter((text): text is string => text !== null)
        .some((text) => text.toLocaleLowerCase().includes(query));
    })
    .sort((left, right) => entryName(left).localeCompare(entryName(right)));
}
