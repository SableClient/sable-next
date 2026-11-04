import { runtimeConfig, type RuntimeConfig } from '#lib/config/runtime-config.js';
import {
  accountConfigUrl,
  mergeAccountConfig,
  type AccountConfig,
} from '#lib/config/account-config.js';
import {
  cachedAccountConfig,
  discoverAccountConfig,
  storeAccountConfig,
} from '#lib/config/account-discovery.js';
import { setAppName } from '#lib/i18n.js';
import {
  applyDeploymentDefaults,
  applyDeploymentLocks,
  applyAccountPreferences,
} from '#lib/settings/preferences.svelte.js';
import { configuration } from './configuration.svelte.js';
import { appName } from './brand.js';
import { loadDeploymentTheme } from './theme.js';
export { removeAccountConfiguration } from '#lib/config/account-discovery.js';

let revision = 0;
let loginRevision = 0;

export async function loadDeployment(): Promise<void> {
  configuration.base = await runtimeConfig();
  applyDeploymentDefaults(configuration.base.settingsDefaults);
  applyDeploymentLocks(configuration.base.settingsLocked);
  applyAccount(null);
}

function applyAccount(config: AccountConfig | null): void {
  configuration.account = mergeAccountConfig(configuration.base, config);
  applyAccountPreferences(config?.settingsDefaults ?? {}, config?.settingsLocked ?? {});
  setAppName(appName(configuration.account));
  void loadDeploymentTheme(configuration.account.branding.themeUrl);
}

export function activateAccountConfiguration(
  session: { account_id: string; user_id: string } | null
): void {
  const current = ++revision;
  clearLoginConfiguration();
  if (!session) {
    applyAccount(null);
    return;
  }
  const server = session.user_id.slice(session.user_id.indexOf(':') + 1);
  const source = accountConfigUrl(server);
  applyAccount(source ? cachedAccountConfig(session.account_id, source) : null);
  if (!source) return;
  void discoverAccountConfig(server).then((config) => {
    if (config === undefined || current !== revision) return;
    storeAccountConfig(session.account_id, source, config);
    applyAccount(config);
  });
}

export async function prepareLoginConfiguration(server: string): Promise<RuntimeConfig> {
  const current = ++loginRevision;
  configuration.login = null;
  const config = mergeAccountConfig(
    configuration.base,
    (await discoverAccountConfig(server)) ?? null
  );
  if (current === loginRevision) configuration.login = config;
  return config;
}

export function clearLoginConfiguration(): void {
  loginRevision += 1;
  configuration.login = null;
}

export function loginConfiguration(): RuntimeConfig {
  return configuration.login ?? configuration.base;
}

export function deployment(): RuntimeConfig {
  return configuration.account;
}
