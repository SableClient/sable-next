import { isRecord } from '#lib/guards.js';
import {
  themeFileMetadata,
  themeSwatches,
  type ThemeFileMetadata,
} from '#lib/settings/theme-file.js';

export const CATALOG_URL = 'https://raw.githubusercontent.com/SableClient/themes/main/catalog.json';
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

function rows(value: unknown): CatalogRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!isRecord(row) || typeof row.basename !== 'string' || typeof row.fullUrl !== 'string') {
      return [];
    }
    const previewUrl = typeof row.previewUrl === 'string' ? row.previewUrl : null;
    return [{ basename: row.basename, previewUrl, fullUrl: row.fullUrl }];
  });
}

export async function fetchCatalog(): Promise<{ themes: CatalogRow[]; tweaks: CatalogRow[] }> {
  const response = await fetch(CATALOG_URL);
  if (!response.ok) throw new Error(`catalog answered ${String(response.status)}`);
  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.themes)) throw new Error('catalog unreadable');
  return { themes: rows(data.themes), tweaks: rows(data.tweaks) };
}

async function describe(kind: CatalogEntry['kind'], row: CatalogRow): Promise<CatalogEntry> {
  const response = await fetch(row.previewUrl ?? row.fullUrl);
  const css = response.ok ? await response.text() : '';
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
