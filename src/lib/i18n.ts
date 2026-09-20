import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { createI18nStore } from 'svelte-i18next';
import en from '../locales/en.json';
import { currentLanguage, setCurrentLanguage } from './language.svelte.js';
import { availableLocales, loadLocaleBundle, SYSTEM_LANGUAGE } from './locales.js';
import { preferences } from './settings/preferences.svelte.js';

function chosenLanguage(): string | undefined {
  const value = preferences.language;
  return value !== SYSTEM_LANGUAGE && availableLocales.includes(value) ? value : undefined;
}

async function ensureBundle(code: string): Promise<void> {
  if (i18next.hasResourceBundle(code, 'translation')) return;
  const bundle = await loadLocaleBundle(code);
  if (bundle) i18next.addResourceBundle(code, 'translation', bundle, true, true);
}

function applyLanguage(code: string): void {
  setCurrentLanguage(code);
  if (typeof document === 'undefined') return;
  document.documentElement.lang = code;
}

const initialLanguage = chosenLanguage();

i18next
  .use(LanguageDetector)
  .init({
    lng: initialLanguage,
    fallbackLng: 'en',
    partialBundledLanguages: true,
    resources: {
      en: { translation: en },
    },
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['querystring', 'navigator'],
      caches: [],
      lookupQuerystring: 'lang',
    },
  })
  .catch((error: unknown) => {
    console.error('[sable i18n] init failed; the UI will render raw translation keys', error);
  });

i18next.on('languageChanged', applyLanguage);
applyLanguage(i18next.resolvedLanguage ?? i18next.language);

export async function setLanguage(value: string): Promise<void> {
  if (value === SYSTEM_LANGUAGE) {
    await i18next.changeLanguage();
    return;
  }
  await ensureBundle(value);
  await i18next.changeLanguage(value);
}

if (initialLanguage !== undefined) {
  setLanguage(initialLanguage).catch((error: unknown) => {
    console.error('[sable i18n] the selected language could not be loaded', error);
  });
}

export const i18n = createI18nStore(i18next);

export function currentLocale(): string {
  return currentLanguage() || (i18next.resolvedLanguage ?? i18next.language);
}

export function t(key: string, options?: Record<string, unknown>): string {
  currentLanguage();
  return i18next.t(key, options);
}
