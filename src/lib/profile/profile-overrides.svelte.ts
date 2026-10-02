import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';
import { ACCOUNT_DATA_KEY_TYPE } from '#lib/settings/account-sync.svelte.js';

import { parseEncryptedFile } from './encrypted-file.js';
import { NAME_COLOR_FIELD } from './fields.js';

export const PROFILE_OVERRIDES_EVENT = 'm.profile_overrides';
export const UNSTABLE_PROFILE_OVERRIDES_EVENT = 'org.matrix.msc4529.profile_overrides';

const USER_ID = /^@[^:]+:.+$/;

type Entries = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface OverrideColors {
  light: string | null;
  dark: string | null;
}

export function readOverrides(content: unknown): Entries {
  if (!isRecord(content)) return {};
  return Object.fromEntries(
    Object.entries(content).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        USER_ID.test(entry[0]) && isRecord(entry[1])
    )
  );
}

function textOrNull(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

export function avatarSource(value: unknown): string | null | undefined {
  const file = parseEncryptedFile(value);
  return file === null ? textOrNull(value) : JSON.stringify(file);
}

export type Protection = 'plain' | 'sealed' | 'locked';

class ProfileOverrides {
  entries = $state.raw<Entries>({});
  protection = $state<Protection>('plain');
  canSeal = $state(false);

  private core: CoreClient | null = null;
  private eventType = UNSTABLE_PROFILE_OVERRIDES_EVENT;
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
    this.entries = {};
    this.protection = 'plain';
    this.canSeal = false;
    this.stopEvents?.();
    this.stopEvents = null;
  }

  of(userId: string): Readonly<Record<string, unknown>> | undefined {
    return this.entries[userId];
  }

  name(userId: string, fallback: string): string {
    const name = textOrNull(this.entries[userId]?.displayname);
    return name === undefined ? fallback : (name ?? userId);
  }

  avatar(userId: string, fallback: string | null): string | null {
    const avatar = avatarSource(this.entries[userId]?.avatar_url);
    return avatar === undefined ? fallback : avatar;
  }

  colors(userId: string): OverrideColors | null | undefined {
    const value = this.entries[userId]?.[NAME_COLOR_FIELD];
    if (value === null) return null;
    if (!isRecord(value)) return undefined;
    const light = typeof value.on_light === 'string' ? value.on_light : null;
    const dark = typeof value.on_dark === 'string' ? value.on_dark : null;
    return light === null && dark === null ? undefined : { light, dark };
  }

  async set(userId: string, fields: Record<string, unknown>): Promise<void> {
    const core = this.core;
    if (core === null) return;
    if (this.protection === 'locked') throw new Error('profile overrides are locked');
    const kept = Object.fromEntries(
      Object.entries({ ...this.entries[userId], ...fields }).filter(
        ([, value]) => value !== undefined
      )
    );
    const { [userId]: _, ...others } = this.entries;
    const next = Object.keys(kept).length > 0 ? { ...others, [userId]: kept } : others;
    const previous = this.entries;
    this.entries = next;
    try {
      await this.write(core, next);
    } catch (error) {
      if (this.entries === next) this.entries = previous;
      throw error;
    }
  }

  private write(core: CoreClient, content: Entries): Promise<void> {
    if (this.eventType === PROFILE_OVERRIDES_EVENT) {
      return core.commands.setAccountData(this.eventType, content);
    }
    return core.commands.setSealedAccountData(this.eventType, content);
  }

  private async pull(generation: number): Promise<void> {
    const core = this.core;
    if (core === null) return;
    try {
      const stable = await core.commands.accountData(PROFILE_OVERRIDES_EVENT);
      if (generation !== this.generation) return;
      if (isRecord(stable)) {
        this.eventType = PROFILE_OVERRIDES_EVENT;
        this.entries = readOverrides(stable);
        this.protection = 'plain';
        this.canSeal = false;
        return;
      }

      const document = await core.commands.sealedAccountData(UNSTABLE_PROFILE_OVERRIDES_EVENT);
      if (generation !== this.generation) return;
      this.eventType = UNSTABLE_PROFILE_OVERRIDES_EVENT;
      this.canSeal = document.can_seal;
      this.protection = document.state;
      this.entries = document.state === 'locked' ? {} : readOverrides(document.content);
      if (document.state === 'plain' && document.can_seal && Object.keys(this.entries).length > 0) {
        await core.commands.setSealedAccountData(this.eventType, document.content);
      }
    } catch (error) {
      console.debug('[sable profile] profile overrides unavailable', error);
    }
  }
}

export const profileOverrides = new ProfileOverrides();
