import { afterEach, describe, expect, it, vi } from 'vitest';

async function privacyItemKeys(): Promise<string[]> {
  vi.resetModules();
  const { settingsCategories } = await import('./registry');
  const privacy = settingsCategories.find((category) => category.id === 'privacy');
  return privacy?.items.map((item) => item.key) ?? [];
}

async function developerItemKeys(): Promise<string[]> {
  vi.resetModules();
  const { settingsCategories } = await import('./registry');
  const developer = settingsCategories.find((category) => category.id === 'developer');
  return developer?.items.map((item) => item.key) ?? [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('telemetry settings', () => {
  it('are absent from a build with no DSN', { timeout: 30_000 }, async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const keys = await privacyItemKeys();
    expect(keys).not.toContain('errorReporting');
    expect(keys).not.toContain('sessionReplay');
  });

  it('appear once a DSN is configured', { timeout: 30_000 }, async () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@o1.ingest.sentry.io/1');
    const keys = await privacyItemKeys();
    expect(keys).toContain('errorReporting');
    expect(keys).toContain('sessionReplay');
  });
});

describe('developer settings', () => {
  it('includes the v1 developer tools switch', async () => {
    expect(await developerItemKeys()).toContain('developerTools');
  });
});

describe('select settings', () => {
  it('survive sanitization for every option value the registry declares', async () => {
    const [{ settingsCategories }, { preferences, sanitize }] = await Promise.all([
      import('./registry'),
      import('./preferences.svelte'),
    ]);
    const base = { ...preferences };

    for (const category of settingsCategories) {
      for (const item of category.items) {
        if (item.type !== 'select') continue;
        for (const option of item.options) {
          const stored: Record<string, unknown> = { [item.key]: option.value };
          expect(sanitize(stored, base)[item.key], `${item.key} = ${option.value}`).toBe(
            option.value
          );
        }
      }
    }
  });

  it('survive sanitization for the member sort set outside the registry', async () => {
    const [{ MEMBER_SORTS }, { preferences, sanitize }] = await Promise.all([
      import('#lib/features/room/member-listing.js'),
      import('./preferences.svelte'),
    ]);
    const base = { ...preferences };

    for (const option of MEMBER_SORTS) {
      const stored: Record<string, unknown> = { memberSort: option };
      expect(sanitize(stored, base).memberSort, `memberSort = ${option}`).toBe(option);
    }
  });
});
