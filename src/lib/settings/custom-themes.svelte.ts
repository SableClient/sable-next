import type { ResolvedTheme } from './theme.js';

const STORAGE_KEY = 'sable-custom-themes';

export type CustomTheme = {
  id: string;
  name: string;
  kind: ResolvedTheme;
  css: string;
};

type StoredThemes = {
  themes: CustomTheme[];
  lightThemeId: string | null;
  darkThemeId: string | null;
};

function load(): StoredThemes {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!stored || typeof stored !== 'object') throw new Error('missing themes');
    const value = stored as Partial<StoredThemes>;
    if (!Array.isArray(value.themes)) throw new Error('invalid themes');
    return {
      themes: value.themes.filter(
        (theme: unknown): theme is CustomTheme =>
          typeof theme === 'object' &&
          theme !== null &&
          typeof (theme as CustomTheme).id === 'string' &&
          typeof (theme as CustomTheme).name === 'string' &&
          ((theme as CustomTheme).kind === 'light' || (theme as CustomTheme).kind === 'dark') &&
          typeof (theme as CustomTheme).css === 'string'
      ),
      lightThemeId: typeof value.lightThemeId === 'string' ? value.lightThemeId : null,
      darkThemeId: typeof value.darkThemeId === 'string' ? value.darkThemeId : null,
    };
  } catch {
    return { themes: [], lightThemeId: null, darkThemeId: null };
  }
}

export const customThemes = $state<StoredThemes>(load());

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customThemes));
  } catch (error) {
    console.debug('[sable themes] themes not persisted', error);
  }
}

export function installCustomTheme(theme: CustomTheme): void {
  customThemes.themes = [...customThemes.themes.filter((item) => item.id !== theme.id), theme];
  customThemes[`${theme.kind}ThemeId`] = theme.id;
  persist();
}

export function selectCustomTheme(kind: ResolvedTheme, id: string | null): void {
  customThemes[`${kind}ThemeId`] = id;
  persist();
}

export function selectedCustomThemeId(kind: ResolvedTheme): string | null {
  return customThemes[`${kind}ThemeId`];
}

export function activeCustomThemeCss(kind: ResolvedTheme): string | undefined {
  const id = customThemes[`${kind}ThemeId`];
  return customThemes.themes.find((theme) => theme.id === id)?.css;
}
