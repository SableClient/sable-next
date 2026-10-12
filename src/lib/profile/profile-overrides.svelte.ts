import type {
  AvatarEditView,
  FieldEdit,
  ProfileOverrideView,
  ProfileOverridesView,
  SealStateView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { ACCOUNT_DATA_KEY_TYPE } from '#lib/settings/account-sync.svelte.js';

export const PROFILE_OVERRIDES_EVENT = 'm.profile_overrides';
export const UNSTABLE_PROFILE_OVERRIDES_EVENT = 'org.matrix.msc4529.profile_overrides';

export interface OverrideColors {
  light: string | null;
  dark: string | null;
}

export interface OverrideEdit {
  display_name: FieldEdit;
  avatar: AvatarEditView;
  color: FieldEdit;
}

export type Protection = SealStateView;

class ProfileOverrides {
  entries = $state.raw<ReadonlyMap<string, ProfileOverrideView>>(new Map());
  protection = $state<Protection>('plain');
  canSeal = $state(false);

  private core: CoreClient | null = null;
  private generation = 0;
  private stopEvents: (() => void) | null = null;

  start(core: CoreClient): void {
    const generation = ++this.generation;
    this.core = core;
    this.stopEvents?.();
    this.stopEvents = core.subscribeEvents((event) => {
      if (
        event.type === 'account_data_changed' &&
        (event.event_type === PROFILE_OVERRIDES_EVENT ||
          event.event_type === UNSTABLE_PROFILE_OVERRIDES_EVENT ||
          event.event_type === ACCOUNT_DATA_KEY_TYPE)
      ) {
        void this.pull(generation);
      }
    });
    void this.pull(generation);
  }

  stop(): void {
    this.generation += 1;
    this.core = null;
    this.entries = new Map();
    this.protection = 'plain';
    this.canSeal = false;
    this.stopEvents?.();
    this.stopEvents = null;
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
    const core = this.core;
    if (core === null) return;
    const generation = this.generation;
    const view = await core.commands.setProfileOverride(userId, edit);
    if (generation === this.generation) this.apply(view);
  }

  private apply(view: ProfileOverridesView): void {
    this.entries = new Map(view.overrides.map((entry) => [entry.user_id, entry]));
    this.protection = view.protection;
    this.canSeal = view.can_seal;
  }

  private async pull(generation: number): Promise<void> {
    const core = this.core;
    if (core === null) return;
    try {
      const view = await core.commands.profileOverrides();
      if (generation === this.generation) this.apply(view);
    } catch (error) {
      console.debug('[sable profile] profile overrides unavailable', error);
    }
  }
}

export const profileOverrides = new ProfileOverrides();
