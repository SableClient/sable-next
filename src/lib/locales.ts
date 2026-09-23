const bundles = import.meta.glob<{ default: Record<string, unknown> }>('../locales/*.json');

export const SYSTEM_LANGUAGE = 'system';

export const availableLocales: string[] = Object.keys(bundles)
  .map((path) => path.slice(path.lastIndexOf('/') + 1, -'.json'.length))
  .sort();

export const languageValues: string[] = [SYSTEM_LANGUAGE, ...availableLocales];

export function localeLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

export async function loadLocaleBundle(code: string): Promise<Record<string, unknown> | null> {
  if (!availableLocales.includes(code)) return null;
  return (await bundles[`../locales/${code}.json`]()).default;
}
