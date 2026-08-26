import {
  BUILT_IN_HOMESERVERS,
  runtimeConfig,
  type HomeserversConfig,
} from '#lib/config/runtime-config.js';

const state = $state<HomeserversConfig>({ ...BUILT_IN_HOMESERVERS });
let loaded = false;

export const homeservers = {
  get list(): readonly string[] {
    return state.list;
  },
  get default(): string {
    return state.default;
  },
  get allowCustom(): boolean {
    return state.allowCustom;
  },
  get items(): { value: string; label: string }[] {
    return state.list.map((value) => ({ value, label: value }));
  },
};

export async function loadHomeservers(): Promise<void> {
  if (loaded) return;
  loaded = true;

  const config = await runtimeConfig();
  state.list = config.homeservers.list;
  state.default = config.homeservers.default;
  state.allowCustom = config.homeservers.allowCustom;
}
