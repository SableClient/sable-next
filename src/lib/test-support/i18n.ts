function translate(key: string, params?: Record<string, unknown>): string {
  return params === undefined ? key : `${key}:${Object.values(params).join(',')}`;
}

export const i18n = {
  subscribe(run: (value: { t: typeof translate }) => void): () => void {
    run({ t: translate });
    return () => {};
  },
};

export const t = translate;

export function currentLocale(): string {
  return 'en';
}
