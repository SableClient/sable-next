import type {
  ProfileOverrideView,
  ProfileOverridesView,
  Rpc,
  RpcParams,
  SealStateView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDataSync } from '#lib/core/account-data-sync.js';
import { ACCOUNT_DATA_KEY_TYPE } from '#lib/settings/account-sync.svelte.js';
import { setProfileOverride } from '#lib/core/api/account.svelte.js';

export const PROFILE_OVERRIDES_EVENT = 'm.profile_overrides';
export const UNSTABLE_PROFILE_OVERRIDES_EVENT = 'org.matrix.msc4529.profile_overrides';

export interface OverrideColors {
  light: string | null;
  dark: string | null;
}

export type OverrideEdit = Omit<RpcParams<Rpc['account']['setProfileOverride']>, 'user_id'>;

export type Protection = SealStateView;

class ProfileOverrides {
  entries = $state.raw<ReadonlyMap<string, ProfileOverrideView>>(new Map());
  protection = $state<Protection>('plain');
  canSeal = $state(false);

  private readonly sync = new AccountDataSync(
    [PROFILE_OVERRIDES_EVENT, UNSTABLE_PROFILE_OVERRIDES_EVENT, ACCOUNT_DATA_KEY_TYPE],
    (generation) => this.pull(generation)
  );

  start(core: CoreClient): void {
    this.sync.start(core);
  }

  stop(): void {
    this.sync.stop();
    this.entries = new Map();
    this.protection = 'plain';
    this.canSeal = false;
  }

  of(userId: string): ProfileOverrideView | undefined {
    return this.entries.get(userId);
  }

  name(userId: string, fallback: string): string {
    const name = this.entries.get(userId)?.display_name;
    if (name === undefined || name.kind === 'unset') return fallback;
    return name.kind === 'set' ? name.value : userId;
  }

  avatar(userId: string, fallback: string | null): string | null {
    const avatar = this.entries.get(userId)?.avatar;
    if (avatar === undefined || avatar.kind === 'unset') return fallback;
    return avatar.kind === 'set' ? avatar.value : null;
  }

  colors(userId: string): OverrideColors | null | undefined {
    const color = this.entries.get(userId)?.color;
    if (color === undefined || color.kind === 'unset') return undefined;
    return color.kind === 'set' ? { light: color.light, dark: color.dark } : null;
  }

  async set(userId: string, edit: OverrideEdit): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    const generation = this.sync.generation;
    const view = await setProfileOverride(core.rpc, userId, edit);
    if (generation === this.sync.generation) this.apply(view);
  }

  private apply(view: ProfileOverridesView): void {
    this.entries = new Map(view.overrides.map((entry) => [entry.user_id, entry]));
    this.protection = view.protection;
    this.canSeal = view.can_seal;
  }

  private async pull(generation: number): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    try {
      const view = await core.rpc.account.profileOverrides();
      if (generation === this.sync.generation) this.apply(view);
    } catch (error) {
      console.debug('[sable profile] profile overrides unavailable', error);
    }
  }
}

export const profileOverrides = new ProfileOverrides();
