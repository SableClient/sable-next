import type { CustomTheme, CustomTweak } from './custom-themes.svelte.js';

export const MAX_THEME_FILE_BYTES = 1024 * 1024;

export type ThemeFile =
  | { kind: 'theme'; theme: CustomTheme }
  | { kind: 'tweak'; tweak: CustomTweak };
export type ThemeFileError = 'size' | 'header';

export function isThemeFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.sable.css');
}

export function themeFileBaseName(name: string): string {
  return name.replace(/\.sable\.css$/i, '');
}

function field(css: string, name: string): string | undefined {
  return css.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();
}

export function parseThemeFile(css: string, fallback: string): ThemeFile | ThemeFileError {
  if (css.length > MAX_THEME_FILE_BYTES) return 'size';
  const name = field(css, 'name') ?? fallback;
  if (css.includes('@sable-tweak')) {
    return { kind: 'tweak', tweak: { id: crypto.randomUUID(), name, css } };
  }
  if (!css.includes('@sable-theme')) return 'header';
  const kind = field(css, 'kind') === 'dark' ? 'dark' : 'light';
  return { kind: 'theme', theme: { id: crypto.randomUUID(), name, kind, css } };
}
