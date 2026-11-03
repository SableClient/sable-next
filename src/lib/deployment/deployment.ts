import {
  EMPTY_RUNTIME_CONFIG,
  runtimeConfig,
  type RuntimeConfig,
} from '#lib/config/runtime-config.js';

let current: RuntimeConfig = EMPTY_RUNTIME_CONFIG;

export async function loadDeployment(): Promise<void> {
  current = await runtimeConfig();
}

export function deployment(): RuntimeConfig {
  return current;
}
