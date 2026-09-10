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

export function applyCustomTheme(css: string | undefined): void {
  const id = 'sable-custom-theme';
  const existing = document.getElementById(id);
  document.body.classList.toggle('remote-theme', css !== undefined);
  if (!css) {
    existing?.remove();
    return;
  }

  const style = existing ?? document.head.appendChild(document.createElement('style'));
  style.id = id;
  style.textContent = renameLegacyThemeIdentifiers(css);
}
