import type { CustomTheme, CustomTweak } from './custom-themes.svelte.js';

export const MAX_THEME_FILE_BYTES = 1024 * 1024;

export type ThemeFile =
  | { kind: 'theme'; theme: CustomTheme }
  | { kind: 'tweak'; tweak: CustomTweak };
export type ThemeFileError = 'size' | 'header';

export interface ThemeFileMetadata {
  name: string | null;
  author: string | null;
  description: string | null;
  kind: 'light' | 'dark';
  contrast: 'low' | 'high';
  tags: string[];
}

const SWATCH_TOKENS = ['bg-container', 'surface-container', 'primary-main', 'bg-on-container'];
const UNSAFE_SWATCH = /\b(?:url|var|env|attr|image|image-set|element|paint)\s*\(|[\\;{}<>]/i;

export const DEFAULT_THEME_SWATCHES = {
  light: ['#fff', '#f4f4f5', '#6e56cf', '#18181b'],
  dark: ['#1b1a21', '#24232c', '#bdb6ec', '#eae8f0'],
} as const;

export function isThemeFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.sable.css');
}

export function themeFileBaseName(name: string): string {
  return name.replace(/\.sable\.css$/i, '');
}

function field(css: string, name: string): string | undefined {
  return css.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();
}

export function themeFileMetadata(css: string): ThemeFileMetadata {
  return {
    name: field(css, 'name') ?? null,
    author: field(css, 'author') ?? null,
    description: field(css, 'description') ?? null,
    kind: field(css, 'kind') === 'dark' ? 'dark' : 'light',
    contrast: field(css, 'contrast') === 'high' ? 'high' : 'low',
    tags: (field(css, 'tags') ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
  };
}

export function safeSwatch(value: string): boolean {
  return value.length <= 64 && !UNSAFE_SWATCH.test(value) && CSS.supports('color', value);
}

export function themeSwatches(css: string): string[] {
  if (css.length > MAX_THEME_FILE_BYTES) return [];
  return SWATCH_TOKENS.flatMap((token) => {
    const value = css.match(new RegExp(`--(?:sable-)?${token}\\s*:\\s*([^;}]+)`))?.[1]?.trim();
    return value && safeSwatch(value) ? [value] : [];
  });
}

export function parseThemeFile(css: string, fallback: string): ThemeFile | ThemeFileError {
  if (css.length > MAX_THEME_FILE_BYTES) return 'size';
  const meta = themeFileMetadata(css);
  const name = meta.name ?? fallback;
  if (css.includes('@sable-tweak')) {
    return { kind: 'tweak', tweak: { id: crypto.randomUUID(), name, css } };
  }
  if (!css.includes('@sable-theme')) return 'header';
  return { kind: 'theme', theme: { id: crypto.randomUUID(), name, kind: meta.kind, css } };
}
