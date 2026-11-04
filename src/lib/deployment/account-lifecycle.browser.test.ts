import { afterEach, expect, test, vi } from 'vitest';
import { parseRuntimeConfig } from '#lib/config/runtime-config.js';
const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  cache: vi.fn(),
  store: vi.fn(),
  preferences: vi.fn(),
}));
vi.mock('#lib/config/runtime-config.js', async (original) => {
  const actual = await original<typeof import('#lib/config/runtime-config.js')>();
  return {
    ...actual,
    runtimeConfig: () =>
      Promise.resolve(actual.parseRuntimeConfig({ branding: { appName: 'Local' } })),
  };
});
vi.mock('#lib/config/account-discovery.js', () => ({
  cachedAccountConfig: mocks.cache,
  discoverAccountConfig: mocks.discover,
  storeAccountConfig: mocks.store,
  removeAccountConfiguration: vi.fn(),
}));
vi.mock('#lib/i18n.js', () => ({ setAppName: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', () => ({
  applyDeploymentDefaults: vi.fn(),
  applyDeploymentLocks: vi.fn(),
  applyAccountPreferences: mocks.preferences,
}));
vi.mock('./theme.js', () => ({ loadDeploymentTheme: vi.fn() }));
import {
  activateAccountConfiguration,
  deployment,
  loadDeployment,
  prepareLoginConfiguration,
  loginConfiguration,
  clearLoginConfiguration,
} from './deployment.js';
afterEach(() => {
  vi.clearAllMocks();
  clearLoginConfiguration();
});

test('switching accounts ignores stale responses', async () => {
  await loadDeployment();
  let finish!: (value: unknown) => void;
  mocks.cache.mockReturnValueOnce({ branding: { appName: 'Account A' } }).mockReturnValueOnce(null);
  mocks.discover
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    )
    .mockResolvedValueOnce({ branding: { appName: 'Account B' } });
  activateAccountConfiguration({ account_id: 'a', user_id: '@alice:a.example:8448' });
  expect(deployment().branding.appName).toBe('Account A');
  expect(mocks.cache).toHaveBeenCalledWith('a', 'https://a.example:8448/.well-known/sable');
  activateAccountConfiguration({ account_id: 'b', user_id: '@bob:b.example' });
  expect(deployment().branding.appName).toBe('Local');
  await Promise.resolve();
  finish({ branding: { appName: 'Stale A' } });
  await Promise.resolve();
  expect(deployment().branding.appName).toBe('Account B');
  activateAccountConfiguration(null);
  expect(deployment().branding.appName).toBe('Local');
  expect(mocks.preferences).toHaveBeenLastCalledWith({}, {});
});

test('login preview leaves the active account unchanged', async () => {
  await loadDeployment();
  mocks.discover.mockResolvedValueOnce({
    branding: { appName: 'Login' },
    settingsLocked: { sendReadReceipts: false },
  });
  await prepareLoginConfiguration('login.example');
  expect(loginConfiguration().branding.appName).toBe('Login');
  expect(deployment().branding.appName).toBe('Local');
  clearLoginConfiguration();
  expect(loginConfiguration()).toEqual(parseRuntimeConfig({ branding: { appName: 'Local' } }));
});

test('switching accounts updates the logo', async () => {
  const { mount, unmount, flushSync } = await import('svelte');
  const { default: Brand } = await import('#lib/ui/SableBrandMark.svelte');
  await loadDeployment();
  mocks.cache
    .mockReturnValueOnce({ branding: { logoUrl: 'https://a.example/logo.svg' } })
    .mockReturnValueOnce(null);
  mocks.discover.mockResolvedValue(undefined);
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(Brand, { target });
  flushSync();
  const defaultLogo = target.querySelector('img')?.getAttribute('src');
  flushSync(() => {
    activateAccountConfiguration({ account_id: 'a', user_id: '@alice:a.example' });
  });
  expect(target.querySelector('img')?.getAttribute('src')).toBe('https://a.example/logo.svg');
  flushSync(() => {
    activateAccountConfiguration({ account_id: 'b', user_id: '@bob:b.example' });
  });
  expect(target.querySelector('img')?.getAttribute('src')).toBe(defaultLogo);
  await unmount(component);
  target.remove();
});
