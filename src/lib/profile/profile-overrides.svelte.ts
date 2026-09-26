import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';

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

class ProfileOverrides {
  entries = $state.raw<Entries>({});

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
          event.event_type === UNSTABLE_PROFILE_OVERRIDES_EVENT)
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
    const avatar = textOrNull(this.entries[userId]?.avatar_url);
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
      await core.commands.setAccountData(this.eventType, next);
    } catch (error) {
      if (this.entries === next) this.entries = previous;
      throw error;
    }
  }

  private async pull(generation: number): Promise<void> {
    const core = this.core;
    if (core === null) return;
    try {
      const stable = await core.commands.accountData(PROFILE_OVERRIDES_EVENT);
      const content = isRecord(stable)
        ? stable
        : await core.commands.accountData(UNSTABLE_PROFILE_OVERRIDES_EVENT);
      if (generation !== this.generation) return;
      this.eventType = isRecord(stable)
        ? PROFILE_OVERRIDES_EVENT
        : UNSTABLE_PROFILE_OVERRIDES_EVENT;
      this.entries = readOverrides(content);
    } catch (error) {
      console.debug('[sable profile] profile overrides unavailable', error);
    }
  }
}

export const profileOverrides = new ProfileOverrides();
