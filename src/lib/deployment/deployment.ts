import {
  EMPTY_RUNTIME_CONFIG,
  runtimeConfig,
  type RuntimeConfig,
} from '#lib/config/runtime-config.js';
import { setAppName } from '#lib/i18n.js';
import { applyDeploymentDefaults, applyDeploymentLocks } from '#lib/settings/preferences.svelte.js';

import { appName } from './brand.js';
import { loadDeploymentTheme } from './theme.js';

let current: RuntimeConfig = EMPTY_RUNTIME_CONFIG;

export async function loadDeployment(): Promise<void> {
  current = await runtimeConfig();
  setAppName(appName(current));
  applyDeploymentDefaults(current.settingsDefaults);
  applyDeploymentLocks(current.settingsLocked);
  void loadDeploymentTheme(current.branding.themeUrl);
}

export function deployment(): RuntimeConfig {
  return current;
}
