import { runtimeConfig } from '#lib/config/runtime-config.js';
import { loginConfiguration } from '#lib/deployment/deployment.js';

const state = $state({ hidden: false });
let loaded = false;

export const passwordFields = {
  get hidden(): boolean {
    return state.hidden || loginConfiguration().hideUsernamePasswordFields;
  },
};

export async function loadPasswordFields(): Promise<void> {
  if (loaded) return;
  loaded = true;

  state.hidden = (await runtimeConfig()).hideUsernamePasswordFields;
}
