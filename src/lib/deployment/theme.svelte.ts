import type { BrandingConfig } from '#lib/config/runtime-config.js';
import {
  applyDeploymentTheme,
  renameLegacyThemeIdentifiers,
  type ResolvedTheme,
} from '#lib/settings/theme.js';
import { parseThemeFile, safeRadius, safeSwatch } from '#lib/settings/theme-file.js';

const PALETTE_TOKEN =
  /^--(?:(?:bg|surface|surface-var|primary|sec|success|warn|crit)-(?:on-)?(?:main|container)(?:-hover|-active|-line)?|focus-ring|shadow-color|overlay)$/;
const RADIUS_TOKEN = /^--radius(?:-inner)?$/;
const ROOT_SELECTORS = new Set([':root', 'html', 'body']);

function rootRules(rules: CSSRuleList): CSSStyleRule[] {
  return Array.from(rules).flatMap((rule) => {
    if (rule instanceof CSSStyleRule) {
      const selectors = rule.selectorText.split(',').map((selector) => selector.trim());
      return selectors.some((selector) => ROOT_SELECTORS.has(selector)) ? [rule] : [];
    }
    if (rule instanceof CSSMediaRule && !matchMedia(rule.media.mediaText).matches) return [];
    return 'cssRules' in rule ? rootRules(rule.cssRules as CSSRuleList) : [];
  });
}

let generation = 0;
let kind: ResolvedTheme = 'light';
let enabled = true;
let configured = $state(false);
let themes: Record<ResolvedTheme, string> = { light: '', dark: '' };
let loginPreview = '';

function apply(): void {
  applyDeploymentTheme(enabled ? loginPreview || themes[kind] : '');
}

export function setLoginThemePreview(css: string): void {
  loginPreview = css;
  apply();
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
  apply();
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

export async function loadLoginThemeColors(url: string, signal: AbortSignal): Promise<string> {
  const css = await fetchThemeCss(url, { credentials: 'omit', signal });
  if (!css) return '';

  const parsed = document.implementation.createHTMLDocument('');
  const style = parsed.createElement('style');
  style.textContent = renameLegacyThemeIdentifiers(css);
  parsed.head.append(style);
  if (!style.sheet) return '';
  const palette = document.createElement('div').style;
  for (const rule of rootRules(style.sheet.cssRules)) {
    for (const token of Array.from(rule.style)) {
      const safe = PALETTE_TOKEN.test(token)
        ? safeSwatch
        : RADIUS_TOKEN.test(token)
          ? safeRadius
          : null;
      if (!safe) continue;
      const value = rule.style.getPropertyValue(token).trim();
      // A palette missing one of its colors can put unreadable text on the login form.
      if (!safe(value)) {
        console.debug('[sable deployment] theme not previewed', url, token);
        return '';
      }
      palette.setProperty(token, value);
    }
  }
  return palette.length > 0 ? `body { ${palette.cssText} }` : '';
}

async function fetchThemeCss(url: string | null, options?: RequestInit): Promise<string> {
  if (url === null) return '';
  const response = await fetch(url, options).catch(() => null);
  if (options?.signal?.aborted) return '';
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
