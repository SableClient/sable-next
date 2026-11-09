import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from '../locales/en.json';
import {
  currentLanguage,
  setCurrentLanguage,
  trackTranslations,
  translationsChanged,
} from './language.svelte.js';
import { DEFAULT_APP_NAME } from './deployment/default-app-name.js';
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
  const language = availableLocales.includes(code) ? code : 'en';
  setCurrentLanguage(language);
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
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
      defaultVariables: { appName: DEFAULT_APP_NAME },
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
i18next.on('initialized', translationsChanged);
i18next.on('languageChanged', translationsChanged);
i18next.store.on('added', translationsChanged);
applyLanguage(i18next.resolvedLanguage ?? i18next.language);

export function setAppName(name: string): void {
  i18next.options.interpolation = {
    ...i18next.options.interpolation,
    defaultVariables: { ...i18next.options.interpolation?.defaultVariables, appName: name },
  };
  translationsChanged();
}

export async function setLanguage(value: string): Promise<void> {
  if (value === SYSTEM_LANGUAGE) {
    await i18next.changeLanguage();
    return;
  }
  const language = availableLocales.includes(value) ? value : 'en';
  await ensureBundle(language);
  await i18next.changeLanguage(language);
}

if (initialLanguage !== undefined) {
  setLanguage(initialLanguage).catch((error: unknown) => {
    console.error('[sable i18n] the selected language could not be loaded', error);
  });
}

export const i18n = {
  get t() {
    if (preferences.developerTools && preferences.showTranslationStrings)
      return (key: string, options?: Record<string, unknown>) =>
        `${key}${options ? JSON.stringify(options) : ''}`;
    trackTranslations();
    return i18next.t;
  },

  get exists() {
    trackTranslations();
    return i18next.exists;
  },
};

export function currentLocale(): string {
  return currentLanguage() || (i18next.resolvedLanguage ?? i18next.language);
}

export function t(key: string, options?: Record<string, unknown>): string {
  trackTranslations();
  return i18next.t(key, options);
}
