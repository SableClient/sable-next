import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { createI18nStore } from 'svelte-i18next';
import en from '../locales/en.json';

i18next
  .use(LanguageDetector)
  .init({
    fallbackLng: 'en',
    resources: {
      en: { translation: en },
    },
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['querystring', 'localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupQuerystring: 'lang',
      lookupLocalStorage: 'sable-locale',
    },
  })
  .catch((error: unknown) => {
    console.error('[sable i18n] init failed; the UI will render raw translation keys', error);
  });

export const i18n = createI18nStore(i18next);
/** Translate outside of templates (not reactive). */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}
