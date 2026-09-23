import { readJson, writeJson } from '#lib/platform/local-json.js';

import type { ResolvedTheme } from './theme.js';

const STORAGE_KEY = 'sable-custom-themes';

export type CustomTheme = {
  id: string;
  name: string;
  kind: ResolvedTheme;
  css: string;
};

export type CustomTweak = {
  id: string;
  name: string;
  css: string;
};

export type StoredThemes = {
  themes: CustomTheme[];
  tweaks: CustomTweak[];
  lightThemeId: string | null;
  darkThemeId: string | null;
  enabledTweakIds: string[];
};

function parse(stored: unknown): StoredThemes {
  if (!stored || typeof stored !== 'object') throw new Error('missing themes');
  const value = stored as Partial<StoredThemes>;
  if (!Array.isArray(value.themes)) throw new Error('invalid themes');
  const tweaks = Array.isArray(value.tweaks) ? value.tweaks.filter(isCustomTweak) : [];
  const held = new Set(tweaks.map((tweak) => tweak.id));
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
    tweaks,
    lightThemeId: typeof value.lightThemeId === 'string' ? value.lightThemeId : null,
    darkThemeId: typeof value.darkThemeId === 'string' ? value.darkThemeId : null,
    enabledTweakIds: Array.isArray(value.enabledTweakIds)
      ? value.enabledTweakIds.filter(
          (id: unknown): id is string => typeof id === 'string' && held.has(id)
        )
      : [],
  };
}

function load(): StoredThemes {
  return readJson(STORAGE_KEY, parse, {
    themes: [],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  });
}

function isCustomTweak(value: unknown): value is CustomTweak {
  if (value === null || typeof value !== 'object') return false;
  const tweak = value as Partial<CustomTweak>;
  return (
    typeof tweak.id === 'string' && typeof tweak.name === 'string' && typeof tweak.css === 'string'
  );
}

export const customThemes = $state<StoredThemes>(load());

function persist(): void {
  writeJson(STORAGE_KEY, customThemes, '[sable themes] themes not persisted');
}

export function installCustomTheme(theme: CustomTheme): void {
  customThemes.themes = [...customThemes.themes.filter((item) => item.id !== theme.id), theme];
  customThemes[`${theme.kind}ThemeId`] = theme.id;
  persist();
}

export function installCustomTweak(tweak: CustomTweak): void {
  customThemes.tweaks = [...customThemes.tweaks.filter((item) => item.id !== tweak.id), tweak];
  if (!customThemes.enabledTweakIds.includes(tweak.id)) {
    customThemes.enabledTweakIds = [...customThemes.enabledTweakIds, tweak.id];
  }
  persist();
}

export function enableCustomTweak(id: string, enabled: boolean): void {
  customThemes.enabledTweakIds = enabled
    ? [...customThemes.enabledTweakIds.filter((item) => item !== id), id]
    : customThemes.enabledTweakIds.filter((item) => item !== id);
  persist();
}

export function replaceCustomThemes(next: StoredThemes): void {
  customThemes.themes = next.themes;
  customThemes.tweaks = next.tweaks;
  customThemes.lightThemeId = next.lightThemeId;
  customThemes.darkThemeId = next.darkThemeId;
  customThemes.enabledTweakIds = next.enabledTweakIds;
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

export function activeTweakCss(): string[] {
  return customThemes.enabledTweakIds
    .map((id) => customThemes.tweaks.find((tweak) => tweak.id === id)?.css)
    .filter((css): css is string => css !== undefined);
}
