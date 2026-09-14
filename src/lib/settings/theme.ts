import type { ThemeMode } from './preferences.svelte.js';

export type ResolvedTheme = Exclude<ThemeMode, 'system'>;

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

export function applyTheme(mode: ThemeMode, systemPrefersDark: boolean): void {
  const theme = resolveTheme(mode, systemPrefersDark);
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
  root.style.colorScheme = theme;
}

const LEGACY_CLASS_ALIASES: Record<string, string> = {
  avatar: 'avatar-root',
  button: 'btn',
  current: 'selection-current',
  highlight: 'selection-highlight',
  menu: 'menu-surface',
  open: 'selection-open',
  progress: 'progress-track',
  switch: 'switch-root',
};

export function renameLegacyThemeIdentifiers(css: string): string {
  return css
    .replace(/--sable-([a-z0-9-]+)/g, (_, name: string) =>
      name === 'shadow' ? '--shadow-color' : `--${name}`
    )
    .replace(/\.sable-([a-z0-9-]+)/g, (_, name: string) => {
      if (LEGACY_CLASS_ALIASES[name]) return `.${LEGACY_CLASS_ALIASES[name]}`;
      return name.startsWith('button-') ? `.btn-${name.slice('button-'.length)}` : `.${name}`;
    });
}

const THEME_STYLE_ID = 'sable-custom-theme';
const TWEAK_STYLE_ID = 'sable-custom-tweaks';

export function applyCustomTheme(css: string | undefined): void {
  const existing = document.getElementById(THEME_STYLE_ID);
  document.body.classList.toggle('remote-theme', css !== undefined);
  if (!css) {
    existing?.remove();
    return;
  }

  const style = existing ?? createStyle(THEME_STYLE_ID, document.getElementById(TWEAK_STYLE_ID));
  style.textContent = renameLegacyThemeIdentifiers(css);
}

export function applyCustomTweaks(css: readonly string[]): void {
  const existing = document.getElementById(TWEAK_STYLE_ID);
  if (css.length === 0) {
    existing?.remove();
    return;
  }

  const style = existing ?? createStyle(TWEAK_STYLE_ID, null);
  style.textContent = css.map(renameLegacyThemeIdentifiers).join('\n');
}

function createStyle(id: string, anchor: Element | null): HTMLStyleElement {
  const style = document.createElement('style');
  style.id = id;
  if (anchor) anchor.before(style);
  else document.head.append(style);
  return style;
}
