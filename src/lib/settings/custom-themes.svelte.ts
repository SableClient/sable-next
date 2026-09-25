import { readJson, writeJson } from '#lib/platform/local-json.js';

import type { ResolvedTheme } from './theme.js';

const STORAGE_KEY = 'sable-custom-themes';

export type CustomTheme = {
  id: string;
  name: string;
  kind: ResolvedTheme;
  css: string;
  source?: string;
};

export type CustomTweak = {
  id: string;
  name: string;
  css: string;
  source?: string;
};

export type StoredThemes = {
  themes: CustomTheme[];
  tweaks: CustomTweak[];
  lightThemeId: string | null;
  darkThemeId: string | null;
  enabledTweakIds: string[];
};

function isCustomTheme(value: unknown): value is CustomTheme {
  if (value === null || typeof value !== 'object') return false;
  const theme = value as Partial<CustomTheme>;
  return (
    typeof theme.id === 'string' &&
    typeof theme.name === 'string' &&
    (theme.kind === 'light' || theme.kind === 'dark') &&
    typeof theme.css === 'string'
  );
}

function isCustomTweak(value: unknown): value is CustomTweak {
  if (value === null || typeof value !== 'object') return false;
  const tweak = value as Partial<CustomTweak>;
  return (
    typeof tweak.id === 'string' && typeof tweak.name === 'string' && typeof tweak.css === 'string'
  );
}

export function readThemes(data: unknown): StoredThemes | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Partial<StoredThemes>;
  if (!Array.isArray(value.themes)) return null;

  return {
    themes: value.themes.filter(isCustomTheme),
    tweaks: Array.isArray(value.tweaks) ? value.tweaks.filter(isCustomTweak) : [],
    lightThemeId: typeof value.lightThemeId === 'string' ? value.lightThemeId : null,
    darkThemeId: typeof value.darkThemeId === 'string' ? value.darkThemeId : null,
    enabledTweakIds: Array.isArray(value.enabledTweakIds)
      ? value.enabledTweakIds.filter((id: unknown): id is string => typeof id === 'string')
      : [],
  };
}

function load(): StoredThemes {
  const stored = readJson(STORAGE_KEY, readThemes, null);
  if (!stored) {
    return { themes: [], tweaks: [], lightThemeId: null, darkThemeId: null, enabledTweakIds: [] };
  }
  const held = new Set(stored.tweaks.map((tweak) => tweak.id));
  return { ...stored, enabledTweakIds: stored.enabledTweakIds.filter((id) => held.has(id)) };
}

export const customThemes = $state<StoredThemes>(load());

function persist(): void {
  writeJson(STORAGE_KEY, customThemes, '[sable themes] themes not persisted');
}

export function installCustomTheme(theme: CustomTheme, activate = true): void {
  customThemes.themes = [...customThemes.themes.filter((item) => item.id !== theme.id), theme];
  if (activate) customThemes[`${theme.kind}ThemeId`] = theme.id;
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

export function removeCustomTheme(id: string): void {
  customThemes.themes = customThemes.themes.filter((theme) => theme.id !== id);
  if (customThemes.lightThemeId === id) customThemes.lightThemeId = null;
  if (customThemes.darkThemeId === id) customThemes.darkThemeId = null;
  persist();
}

export function removeCustomTweak(id: string): void {
  customThemes.tweaks = customThemes.tweaks.filter((tweak) => tweak.id !== id);
  customThemes.enabledTweakIds = customThemes.enabledTweakIds.filter((item) => item !== id);
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

export type ThemePreview = { source: string; name: string; kind: ResolvedTheme; css: string };

export const themePreview = $state<{ current: ThemePreview | null }>({ current: null });

export function previewTheme(preview: ThemePreview): void {
  themePreview.current = preview;
}

export function clearThemePreview(): void {
  themePreview.current = null;
}
