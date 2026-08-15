import { afterEach, describe, expect, it, vi } from 'vitest';

async function privacyItemKeys(): Promise<string[]> {
  vi.resetModules();
  const { settingsCategories } = await import('./registry');
  const privacy = settingsCategories.find((category) => category.id === 'privacy');
  return privacy?.items.map((item) => item.key) ?? [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('telemetry settings', () => {
  it('are absent from a build with no DSN', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const keys = await privacyItemKeys();
    expect(keys).not.toContain('errorReporting');
    expect(keys).not.toContain('sessionReplay');
  });

  it('appear once a DSN is configured', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@o1.ingest.sentry.io/1');
    const keys = await privacyItemKeys();
    expect(keys).toContain('errorReporting');
    expect(keys).toContain('sessionReplay');
  });
});
