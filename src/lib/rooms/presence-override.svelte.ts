import type { PresenceOverrideView, PresenceView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDataSync } from '#lib/core/account-data-sync.js';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

const PERSISTENT_EVENTS = [
  'm.presence.persistent',
  'org.continuwuity.presence_v2.msc4532.presence.persistent',
];

class PresenceOverride {
  /** `null` until loaded, and while the homeserver does not support MSC4532. */
  view = $state.raw<PresenceOverrideView | null>(null);

  private readonly sync = new AccountDataSync(PERSISTENT_EVENTS, (generation) =>
    this.pull(generation)
  );

  get supported(): boolean {
    return this.view !== null;
  }

  start(core: CoreClient): void {
    this.sync.start(core);
  }

  stop(): void {
    this.sync.stop();
    this.view = null;
  }

  async set(next: PresenceOverrideView): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    const generation = this.sync.generation;
    const view = await core.rpc.account.setPresenceOverride({ override: next });
    if (generation !== this.sync.generation) return;
    this.view = view;
  }

  private async pull(generation: number): Promise<void> {
    try {
      const core = this.sync.core;
      if (core === null) return;
      const view = await core.rpc.account.presenceOverride();
      if (generation !== this.sync.generation) return;
      this.view = view;
    } catch (error) {
      console.debug('[sable presence] presence override unavailable', error);
    }
  }
}

export const presenceOverride = new PresenceOverride();

const LEGACY_CHOICES: readonly PresenceView[] = ['online', 'unavailable', 'offline'];
const REVISED_CHOICES: readonly PresenceView[] = ['online', 'unavailable', 'busy', 'offline'];

export function presenceChoices(): readonly PresenceView[] {
  return presenceOverride.supported ? REVISED_CHOICES : LEGACY_CHOICES;
}

export function ownPresence(): PresenceView {
  const view = presenceOverride.view;
  return view ? (view.state ?? 'online') : preferences.presence;
}

export function ownStatusMessage(): string {
  const view = presenceOverride.view;
  return view ? (view.status_message ?? '') : preferences.presenceStatusMessage;
}

/** Picking `online` clears the override, so the client's own activity decides again. */
export async function setOwnPresence(
  state: PresenceView,
  statusMessage: string = ownStatusMessage()
): Promise<void> {
  if (presenceOverride.supported) {
    await presenceOverride.set({
      state: state === 'online' ? null : state,
      status_message: statusMessage.trim() || null,
    });
    return;
  }
  setPreference('presence', state);
  setPreference('presenceStatusMessage', statusMessage.trim());
}
