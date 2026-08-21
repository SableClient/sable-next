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

export function applyCustomTheme(css: string | undefined): void {
  const id = 'sable-custom-theme';
  const existing = document.getElementById(id);
  document.body.classList.toggle('sable-remote-theme', css !== undefined);
  if (!css) {
    existing?.remove();
    return;
  }

  const style = existing ?? document.head.appendChild(document.createElement('style'));
  style.id = id;
  style.textContent = css;
}
