import {
  EMPTY_RUNTIME_CONFIG,
  runtimeConfig,
  type RuntimeConfig,
} from '#lib/config/runtime-config.js';
import { setAppName } from '#lib/i18n.js';

import { appName } from './brand.js';

let current: RuntimeConfig = EMPTY_RUNTIME_CONFIG;

export async function loadDeployment(): Promise<void> {
  current = await runtimeConfig();
  setAppName(appName(current));
}

export function deployment(): RuntimeConfig {
  return current;
}
