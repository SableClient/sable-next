import type { CoreEvent } from '#src/generated/CoreEvent';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { ignoreError } from './call-transport';
import { startRingtone, type Ringtone } from './ringtone';

export type IncomingCall = {
  roomId: string;
  notificationEventId: string;
  sender: string;
  ring: boolean;
  expiresAtMs: number;
};

export class IncomingCalls {
  calls = $state.raw<IncomingCall[]>([]);

  readonly #client: CoreClient;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- timers, never rendered from
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #ringtone: Ringtone | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(client: CoreClient) {
    this.#client = client;
  }

  start(): () => void {
    this.#unsubscribe = this.#client.subscribeEvents((event) => {
      this.#onEvent(event);
    });
    return () => {
      this.stop();
    };
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.calls = [];
    this.#syncRingtone();
  }

  accept(call: IncomingCall): void {
    this.#drop(call.notificationEventId);
  }

  async decline(call: IncomingCall): Promise<void> {
    this.#drop(call.notificationEventId);
    try {
      await this.#client.commands.declineCall(call.roomId, call.notificationEventId);
    } catch {
      ignoreError();
    }
  }

  #onEvent(event: CoreEvent): void {
    if (event.type === 'incoming_call_ended') {
      this.#drop(event.notification_event_id);
      return;
    }
    if (event.type !== 'incoming_call') return;

    const call: IncomingCall = {
      roomId: event.room_id,
      notificationEventId: event.notification_event_id,
      sender: event.sender,
      ring: event.ring,
      expiresAtMs: event.expires_at_ms,
    };

    const remaining = call.expiresAtMs - Date.now();
    if (remaining <= 0) return;

    this.calls = [
      call,
      ...this.calls.filter((c) => c.notificationEventId !== call.notificationEventId),
    ];
    this.#timers.set(
      call.notificationEventId,
      setTimeout(() => {
        this.#drop(call.notificationEventId);
      }, remaining)
    );
    this.#syncRingtone();
  }

  #drop(notificationEventId: string): void {
    const timer = this.#timers.get(notificationEventId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(notificationEventId);
    }
    this.calls = this.calls.filter((call) => call.notificationEventId !== notificationEventId);
    this.#syncRingtone();
  }

  #syncRingtone(): void {
    const shouldRing = this.calls.some((call) => call.ring);
    if (shouldRing && !this.#ringtone) {
      this.#ringtone = startRingtone();
      return;
    }
    if (!shouldRing && this.#ringtone) {
      this.#ringtone.stop();
      this.#ringtone = undefined;
    }
  }
}
