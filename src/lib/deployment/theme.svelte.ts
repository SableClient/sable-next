import type { BrandingConfig } from '#lib/config/runtime-config.js';
import { applyDeploymentTheme, type ResolvedTheme } from '#lib/settings/theme.js';
import { parseThemeFile } from '#lib/settings/theme-file.js';

let generation = 0;
let kind: ResolvedTheme = 'light';
let enabled = true;
let configured = $state(false);
let themes: Record<ResolvedTheme, string> = { light: '', dark: '' };

function apply(): void {
  applyDeploymentTheme(enabled ? themes[kind] : '');
}

export function setDeploymentThemeKind(next: ResolvedTheme): void {
  kind = next;
  apply();
}

export function setDeploymentThemeEnabled(next: boolean): void {
  enabled = next;
  apply();
}

/** Whether the deployment names a theme at all, so the setting to turn it off has a use. */
export function hasDeploymentTheme(): boolean {
  return configured;
}

export async function loadDeploymentTheme(
  branding: Pick<BrandingConfig, 'themeUrl' | 'lightThemeUrl' | 'darkThemeUrl'>
): Promise<void> {
  const current = ++generation;
  themes = { light: '', dark: '' };
  applyDeploymentTheme('');
  const lightUrl = branding.lightThemeUrl ?? branding.themeUrl;
  const darkUrl = branding.darkThemeUrl ?? branding.themeUrl;
  configured = lightUrl !== null || darkUrl !== null;
  const light = fetchThemeCss(lightUrl);
  const dark = darkUrl === lightUrl ? light : fetchThemeCss(darkUrl);
  const loaded = { light: await light, dark: await dark };
  if (current !== generation) return;
  themes = loaded;
  apply();
}

async function fetchThemeCss(url: string | null): Promise<string> {
  if (url === null) return '';
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) {
    console.debug('[sable deployment] theme not applied', url, response?.status ?? 'offline');
    return '';
  }
  const text = await response.text().catch(() => null);
  if (text === null) return '';
  const file = parseThemeFile(text, url);
  if (typeof file === 'string') {
    console.debug('[sable deployment] theme not applied', url, file);
    return '';
  }
  return file.kind === 'theme' ? file.theme.css : file.tweak.css;
}
