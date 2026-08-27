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
