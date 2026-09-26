import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SystemCallAction } from '@sableclient/tauri-plugin-livekit-mobile';
import {
  endSystemCall,
  listenSystemCallActions,
  reportIncomingSystemCall,
  systemCallKey,
} from '#lib/platform/calls.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { ignoreError } from './call-transport';
import { ringtoneVolume, startRingtone, type Ringtone } from './ringtone';

export type IncomingCall = {
  roomId: string;
  notificationEventId: string;
  sender: string;
  senderName: string | null;
  roomName: string | null;
  ring: boolean;
  hasVideo: boolean;
  expiresAtMs: number;
};

export type SystemAnswer = { uuid: string; callId: string; roomId: string; hasVideo: boolean };

export class IncomingCalls {
  calls = $state.raw<IncomingCall[]>([]);

  readonly #client: CoreClient;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- timers, never rendered from
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- never rendered from
  readonly #system = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- never rendered from
  readonly #uuids = new Map<string, string>();
  readonly #onSystemAnswer: (answer: SystemAnswer) => void;
  #ringtone: Ringtone | undefined;
  #unsubscribe: (() => void) | undefined;
  #stopSystemActions: (() => void) | undefined;

  constructor(client: CoreClient, onSystemAnswer: (answer: SystemAnswer) => void = () => {}) {
    this.#client = client;
    this.#onSystemAnswer = onSystemAnswer;
  }

  start(): () => void {
    this.#unsubscribe = this.#client.subscribeEvents((event) => {
      this.#onEvent(event);
    });
    let stopped = false;
    void listenSystemCallActions((action) => {
      this.#onSystemAction(action);
    }).then((stop) => {
      if (stopped) stop();
      else this.#stopSystemActions = stop;
    });
    return () => {
      stopped = true;
      this.stop();
    };
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#stopSystemActions?.();
    this.#stopSystemActions = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const callId of this.#system) void endSystemCall(this.#systemKey(callId));
    this.#system.clear();
    this.#uuids.clear();
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
    if (!event.ring && !preferences.ringForGroupCalls) return;

    const call: IncomingCall = {
      roomId: event.room_id,
      notificationEventId: event.notification_event_id,
      sender: event.sender,
      senderName: event.sender_name,
      roomName: event.room_name,
      ring: event.ring,
      hasVideo: event.has_video,
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
    void this.#raiseSystemCall(call);
    this.#syncRingtone();
  }

  #systemKey(notificationEventId: string): string {
    return systemCallKey(notificationEventId, this.#uuids.get(notificationEventId) ?? '');
  }

  #onSystemAction(action: SystemCallAction): void {
    const call = this.calls.find(
      (entry) => this.#uuids.get(entry.notificationEventId) === action.uuid
    );
    if (call) this.#system.delete(call.notificationEventId);
    if (action.action === 'answer') {
      const roomId = call?.roomId ?? action.roomId;
      if (call) this.#drop(call.notificationEventId);
      if (roomId) {
        this.#onSystemAnswer({
          uuid: action.uuid,
          callId: call ? this.#systemKey(call.notificationEventId) : action.uuid,
          roomId,
          hasVideo: call?.hasVideo ?? false,
        });
      }
    } else if (action.action === 'end' && call) {
      void this.decline(call);
    }
  }

  async #raiseSystemCall(call: IncomingCall): Promise<void> {
    const uuid = crypto.randomUUID();
    this.#uuids.set(call.notificationEventId, uuid);
    const taken = await reportIncomingSystemCall({
      callId: call.notificationEventId,
      uuid,
      callerName: call.senderName ?? call.roomName ?? call.sender,
      hasVideo: call.hasVideo,
      roomId: call.roomId,
    });
    if (!taken) return;
    if (!this.calls.some((c) => c.notificationEventId === call.notificationEventId)) {
      void endSystemCall(systemCallKey(call.notificationEventId, uuid));
      return;
    }
    this.#system.add(call.notificationEventId);
    this.#syncRingtone();
  }

  #drop(notificationEventId: string): void {
    const timer = this.#timers.get(notificationEventId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(notificationEventId);
    }
    if (this.#system.delete(notificationEventId)) {
      void endSystemCall(this.#systemKey(notificationEventId));
    }
    this.#uuids.delete(notificationEventId);
    this.calls = this.calls.filter((call) => call.notificationEventId !== notificationEventId);
    this.#syncRingtone();
  }

  #syncRingtone(): void {
    const shouldRing =
      preferences.incomingCallSound &&
      this.calls.some((call) => !this.#system.has(call.notificationEventId));
    if (shouldRing && !this.#ringtone) {
      this.#ringtone = startRingtone(ringtoneVolume(preferences.callRingtoneVolume));
      return;
    }
    if (!shouldRing && this.#ringtone) {
      this.#ringtone.stop();
      this.#ringtone = undefined;
    }
  }
}
