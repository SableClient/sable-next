import type { ThemeMode } from './definitions.js';

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
  root.dataset.theme = theme;
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
    .replace(/--font-secondary(?![a-z0-9-])/g, '--font-family')
    .replace(/--font-monospace(?![a-z0-9-])/g, '--font-family-mono')
    .replace(/\.sable-([a-z0-9-]+)/g, (_, name: string) => {
      if (LEGACY_CLASS_ALIASES[name]) return `.${LEGACY_CLASS_ALIASES[name]}`;
      return name.startsWith('button-') ? `.btn-${name.slice('button-'.length)}` : `.${name}`;
    });
}

const DEPLOYMENT_STYLE_ID = 'sable-deployment-theme';
const THEME_STYLE_ID = 'sable-custom-theme';
const TWEAK_STYLE_ID = 'sable-custom-tweaks';
const QUICK_CSS_STYLE_ID = 'sable-quick-css';

export function applyCustomTheme(css: string | undefined): void {
  const existing = document.getElementById(THEME_STYLE_ID);
  document.body.classList.toggle('remote-theme', css !== undefined);
  if (!css) {
    existing?.remove();
    return;
  }

  const style =
    existing ??
    createStyle(
      THEME_STYLE_ID,
      document.getElementById(TWEAK_STYLE_ID) ?? document.getElementById(QUICK_CSS_STYLE_ID)
    );
  setCss(style, renameLegacyThemeIdentifiers(css));
}

export function applyDeploymentTheme(css: string): void {
  if (!css) {
    document.getElementById(DEPLOYMENT_STYLE_ID)?.remove();
    return;
  }
  const style =
    document.getElementById(DEPLOYMENT_STYLE_ID) ??
    createStyle(
      DEPLOYMENT_STYLE_ID,
      document.getElementById(THEME_STYLE_ID) ??
        document.getElementById(TWEAK_STYLE_ID) ??
        document.getElementById(QUICK_CSS_STYLE_ID)
    );
  setCss(style, renameLegacyThemeIdentifiers(css));
}

export function applyCustomTweaks(css: readonly string[]): void {
  const existing = document.getElementById(TWEAK_STYLE_ID);
  if (css.length === 0) {
    existing?.remove();
    return;
  }

  const style =
    existing ?? createStyle(TWEAK_STYLE_ID, document.getElementById(QUICK_CSS_STYLE_ID));
  setCss(style, css.map(renameLegacyThemeIdentifiers).join('\n'));
}

export function applyFontFamily(family: string): void {
  applyFontPreference('--font-family', '--font-family-base', family);
  // Override themes that set font-family directly on body.
  if (family.trim()) document.body.style.setProperty('font-family', 'var(--font-family)');
  else document.body.style.removeProperty('font-family');
}

export function applyFontFamilyMono(family: string): void {
  applyFontPreference('--font-family-mono', '--font-family-mono-base', family);
}

function applyFontPreference(property: string, fallback: string, family: string): void {
  const name = family.trim();
  // Body variables would otherwise override the inherited root preference.
  for (const style of [document.documentElement.style, document.body.style]) {
    if (name) style.setProperty(property, `${name}, var(${fallback})`);
    else style.removeProperty(property);
  }
}

export function applyQuickCss(css: string): void {
  const existing = document.getElementById(QUICK_CSS_STYLE_ID);
  if (!css) {
    existing?.remove();
    return;
  }

  const style = existing ?? createStyle(QUICK_CSS_STYLE_ID, null);
  setCss(style, css);
  keepQuickCssLast();
}

let headObserver: MutationObserver | undefined;

function keepQuickCssLast(): void {
  if (headObserver) return;
  headObserver = new MutationObserver(() => {
    const style = document.getElementById(QUICK_CSS_STYLE_ID);
    if (style && document.head.lastElementChild !== style) document.head.append(style);
  });
  headObserver.observe(document.head, { childList: true });
}

// Rewriting identical text still makes the browser reparse the sheet and restyle the whole page.
function setCss(style: HTMLElement, css: string): void {
  if (style.textContent !== css) style.textContent = css;
}

function createStyle(id: string, anchor: Element | null): HTMLStyleElement {
  const style = document.createElement('style');
  style.id = id;
  if (anchor) anchor.before(style);
  else document.head.append(style);
  return style;
}
