import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SystemCallAction } from '#lib/platform/calls.js';
import {
  endSystemCall,
  listenSystemCallActions,
  reportIncomingSystemCall,
  systemCallKey,
} from '#lib/platform/calls.js';
import { isAndroid } from '#lib/platform/os.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { type NotificationSound } from '../notifications/sound';
import { playSound } from '../notifications/sound';

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
  readonly #reporting = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- never rendered from
  readonly #uuids = new Map<string, { uuid: string; answered: boolean }>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- never rendered from
  readonly #finished = new Set<string>();
  readonly #onSystemAnswer: (answer: SystemAnswer) => void;
  #ringtone: Promise<NotificationSound> | undefined;
  #unsubscribe: (() => void) | undefined;
  #stopSystemActions: (() => void) | undefined;
  #started = false;

  constructor(client: CoreClient, onSystemAnswer: (answer: SystemAnswer) => void = () => {}) {
    this.#client = client;
    this.#onSystemAnswer = onSystemAnswer;
  }

  start(): () => void {
    this.#started = true;
    this.#unsubscribe = this.#client.subscribeEvents((event) => {
      this.#onEvent(event);
    });
    let stopped = false;
    void listenSystemCallActions((action) => {
      this.#onSystemAction(action);
    }).then((stop) => {
      if (stopped || !this.#started) stop();
      else this.#stopSystemActions = stop;
    });
    return () => {
      stopped = true;
      this.stop();
    };
  }

  stop(): void {
    this.#started = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#stopSystemActions?.();
    this.#stopSystemActions = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const callId of this.#system) void endSystemCall(this.#systemKey(callId));
    this.#system.clear();
    this.#reporting.clear();
    this.#uuids.clear();
    this.#finished.clear();
    this.calls = [];
    this.#syncRingtone();
  }

  accept(call: IncomingCall): void {
    this.#drop(call.notificationEventId);
  }

  async decline(call: Pick<IncomingCall, 'roomId' | 'notificationEventId'>): Promise<void> {
    if (this.#finished.has(call.notificationEventId)) return;
    this.#drop(call.notificationEventId);
    try {
      await this.#client.rpc.calls.decline({
        room_id: call.roomId,
        notification_event_id: call.notificationEventId,
      });
    } catch (error) {
      console.warn('[sable call] could not decline call', error);
    }
  }

  #onEvent(event: CoreEvent): void {
    if (event.type === 'incoming_call_ended') {
      this.#drop(event.notification_event_id);
      return;
    }
    if (event.type !== 'incoming_call') return;
    if (this.#finished.has(event.notification_event_id)) return;

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
    if (call.ring || preferences.ringForGroupCalls) void this.#raiseSystemCall(call);
    this.#syncRingtone();
  }

  #systemKey(notificationEventId: string): string {
    return systemCallKey(notificationEventId, this.#uuids.get(notificationEventId)?.uuid ?? '');
  }

  #onSystemAction(action: SystemCallAction): void {
    if (!this.#started || (action.action !== 'answer' && action.action !== 'end')) return;
    const call = this.calls.find(
      (entry) =>
        this.#systemKey(entry.notificationEventId) === action.uuid ||
        entry.notificationEventId === action.notificationEventId
    );
    const notificationEventId = call?.notificationEventId ?? action.notificationEventId;
    if (
      this.#finished.has(action.uuid) ||
      (notificationEventId !== undefined && this.#finished.has(notificationEventId))
    ) {
      return;
    }
    const roomId = call?.roomId ?? action.roomId;
    if (!roomId) return;
    if (action.action === 'answer') {
      const callId = systemCallKey(notificationEventId ?? action.uuid, action.uuid);
      const reported = call && this.#uuids.get(call.notificationEventId);
      if (reported) reported.answered = true;
      this.#finished.add(action.uuid);
      if (notificationEventId !== undefined) {
        this.#system.delete(notificationEventId);
        this.#drop(notificationEventId);
      }
      this.#onSystemAnswer({
        uuid: action.uuid,
        callId,
        roomId,
        hasVideo: call?.hasVideo ?? action.hasVideo ?? false,
      });
    } else if (notificationEventId !== undefined) {
      this.#system.delete(notificationEventId);
      void this.decline({ roomId, notificationEventId });
      this.#finished.add(action.uuid);
    }
  }

  async #raiseSystemCall(call: IncomingCall): Promise<void> {
    this.#reporting.add(call.notificationEventId);
    const uuid = crypto.randomUUID();
    const reported = { uuid, answered: false };
    this.#uuids.set(call.notificationEventId, reported);
    const taken = await reportIncomingSystemCall({
      callId: call.notificationEventId,
      uuid,
      callerName: call.senderName ?? call.roomName ?? call.sender,
      hasVideo: call.hasVideo,
      roomId: call.roomId,
    });
    this.#reporting.delete(call.notificationEventId);
    if (!taken || reported.answered) {
      this.#syncRingtone();
      return;
    }
    if (!this.calls.some((c) => c.notificationEventId === call.notificationEventId)) {
      void endSystemCall(systemCallKey(call.notificationEventId, uuid));
      return;
    }
    this.#system.add(call.notificationEventId);
    this.#syncRingtone();
  }

  #drop(notificationEventId: string): void {
    this.#finished.add(notificationEventId);
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
      // Web Audio bypasses Android's ringer mode.
      !isAndroid() &&
      preferences.incomingCallSound &&
      this.calls.some(
        (call) =>
          (call.ring || preferences.ringForGroupCalls) &&
          !this.#system.has(call.notificationEventId) &&
          !this.#reporting.has(call.notificationEventId)
      );
    if (shouldRing && !this.#ringtone) {
      const ringtone = playSound('incoming_call', { loop: true });
      this.#ringtone = ringtone;
      void ringtone.catch((error: unknown) => {
        if (this.#ringtone === ringtone) this.#ringtone = undefined;
        console.warn('[sable call] could not play ringtone', error);
      });
      return;
    }
    if (!shouldRing && this.#ringtone) {
      void this.#ringtone.then(
        (sound) => {
          sound.stop();
        },
        () => {}
      );
      this.#ringtone = undefined;
    }
  }
}
