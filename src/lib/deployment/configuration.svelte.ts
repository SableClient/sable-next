import { EMPTY_RUNTIME_CONFIG, type RuntimeConfig } from '#lib/config/runtime-config.js';

export const configuration = $state<{
  base: RuntimeConfig;
  account: RuntimeConfig;
  login: RuntimeConfig | null;
}>({
  base: EMPTY_RUNTIME_CONFIG,
  account: EMPTY_RUNTIME_CONFIG,
  login: null,
});
