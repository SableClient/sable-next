import { createContext } from 'svelte';

import type { CallMemberView } from '#src/generated/CallMemberView';
import type { CoreEvent } from '#src/generated/CoreEvent';
import type { CallGrant, CoreClient } from '#lib/core/client.svelte.js';

import type { CallEncryptionKey, CallTransport, CallTransportState } from './call-transport';
import { decodeCallKey, idleTransportState, ignoreError } from './call-transport';
import { acquireCallOwner, type CallOwnerLease } from './call-owner';
import { createLivekitTransport, type LivekitTransport } from './livekit-transport';
import { createNativeTransport } from './native-transport';
import { isCallE2eeSupported } from './key-provider';
import { commandErrorCode } from './command-error';

export type CallLifecycle = 'idle' | 'joining' | 'connecting' | 'active' | 'leaving' | 'failed';

export type CallFailure = 'busy' | 'no-focus' | 'e2ee-unsupported' | 'e2ee-failed' | 'setup-failed';

export type CallMedia = { microphone: boolean; camera: boolean };

const OWN_KEY_TIMEOUT_MS = 10_000;

type PendingEvent = Extract<CoreEvent, { type: 'call_encryption_key' | 'call_members' }>;

const isCallEvent = (event: CoreEvent): event is PendingEvent =>
  event.type === 'call_encryption_key' || event.type === 'call_members';

const isLivekit = (transport: CallTransport): transport is LivekitTransport =>
  'keyProvider' in transport;

export type CallSessionDeps = {
  createTransport?: (encryptMedia: boolean) => CallTransport;
  e2eeSupported?: () => boolean;
};

export class CallSession {
  lifecycle = $state<CallLifecycle>('idle');
  failure = $state<CallFailure | null>(null);
  roomId = $state<string | null>(null);
  members = $state.raw<CallMemberView[]>([]);
  transport = $state.raw<CallTransportState>(idleTransportState());
  mediaReady = $state(false);
  encryptsMedia = $state(false);

  readonly #client: CoreClient;
  readonly #deps: CallSessionDeps;
  #media = $state.raw<CallTransport | undefined>(undefined);
  #livekit = $state.raw<LivekitTransport | undefined>(undefined);
  #grant: CallGrant | undefined;
  #session: number | undefined;
  #lease: CallOwnerLease | undefined;
  #unsubscribe: (() => void) | undefined;
  #unsubscribeTransport: (() => void) | undefined;
  #unsubscribeKeys: (() => void) | undefined;
  #buffer: PendingEvent[] = [];
  #pendingKeys: CallEncryptionKey[] = [];
  #ownKeyPending = false;
  #connected = false;
  #ownKey: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(client: CoreClient, deps: CallSessionDeps = {}) {
    this.#client = client;
    this.#deps = deps;
  }

  get room(): LivekitTransport | undefined {
    return this.#livekit;
  }

  get canScreenShare(): boolean {
    return this.#media?.capabilities.screenShare !== undefined;
  }

  get active(): boolean {
    return this.lifecycle !== 'idle' && this.lifecycle !== 'failed';
  }

  async join(roomId: string, media: CallMedia, serviceUrl: string | null = null): Promise<void> {
    if (this.active) return;

    const lease = acquireCallOwner('livekit-js', roomId);
    if (!lease) {
      this.#fail('busy');
      return;
    }

    this.#lease = lease;
    this.roomId = roomId;
    this.lifecycle = 'joining';
    this.failure = null;
    this.mediaReady = false;

    this.#buffer = [];
    this.#unsubscribe = this.#client.subscribeEvents((event) => {
      this.#onCoreEvent(event);
    });

    try {
      const grant = await this.#client.joinCall(roomId, serviceUrl);
      this.#session = grant.session;

      const supported = this.#deps.e2eeSupported ?? isCallE2eeSupported;
      if (grant.encryptMedia && !supported()) {
        await this.#teardown();
        this.#fail('e2ee-unsupported');
        return;
      }

      const transport =
        this.#deps.createTransport?.(grant.encryptMedia) ??
        (await createNativeTransport(String(grant.session))) ??
        createLivekitTransport({ encryptMedia: grant.encryptMedia });
      this.#media = transport;
      this.#livekit = isLivekit(transport) ? transport : undefined;
      this.#unsubscribeTransport = transport.subscribe((state) => {
        this.transport = state;
      });

      const provider = this.#livekit?.keyProvider;
      this.#unsubscribeKeys = provider?.subscribe((keyState) => {
        if (keyState.lastFailure) {
          this.#ownKey?.reject(new Error('own-key-failed'));
          this.#ownKey = undefined;
          return;
        }
        if (keyState.ready) this.#markReady();
      });

      this.#grant = grant;

      this.encryptsMedia = grant.encryptMedia;
      this.mediaReady = !grant.encryptMedia;
      this.#drain();

      if (grant.encryptMedia) await this.#waitForOwnKey();

      this.lifecycle = 'connecting';
      const encryptionKeys = this.#pendingKeys.splice(0, this.#pendingKeys.length);
      await transport.connect({
        url: grant.url,
        token: grant.jwt,
        microphoneEnabled: media.microphone,
        cameraEnabled: media.camera,
        encryptionKeys,
      });
      this.#connected = true;
      if (this.#ownKeyPending) this.#markReady();

      this.lifecycle = 'active';
    } catch (error) {
      await this.#teardown();
      this.#fail(this.#classify(error));
    }
  }

  async leave(): Promise<void> {
    if (this.lifecycle === 'idle') return;
    this.lifecycle = 'leaving';
    await this.#teardown();
    this.lifecycle = 'idle';
    this.failure = null;
    this.roomId = null;
  }

  clearFailure(): void {
    if (this.lifecycle !== 'failed') return;
    this.lifecycle = 'idle';
    this.failure = null;
    this.roomId = null;
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.#media?.setMicrophoneEnabled(enabled);
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.#media?.setCameraEnabled(enabled);
  }

  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    await this.#media?.capabilities.screenShare?.setEnabled(enabled);
  }

  #classify(error: unknown): CallFailure {
    if (error instanceof Error && error.message === 'own-key-timeout') return 'e2ee-failed';
    return commandErrorCode(error) === 'no_call_focus' ? 'no-focus' : 'setup-failed';
  }

  #fail(failure: CallFailure): void {
    this.failure = failure;
    this.lifecycle = 'failed';
  }

  #onCoreEvent(event: CoreEvent): void {
    if (!isCallEvent(event)) return;
    if (!this.#grant) {
      this.#buffer.push(event);
      return;
    }
    this.#apply(event);
  }

  #drain(): void {
    const buffered = this.#buffer;
    this.#buffer = [];
    for (const event of buffered) this.#apply(event);
  }

  #apply(event: PendingEvent): void {
    if (this.#session === undefined || event.session !== this.#session) return;

    if (event.type === 'call_members') {
      this.members = event.members;
      return;
    }

    const key = decodeCallKey(event.key);
    if (!key) return;

    const entry = { identity: event.identity, keyIndex: event.key_index, key };

    const provider = this.#livekit?.keyProvider;
    if (provider) {
      provider.setKey(entry, event.own);
      return;
    }

    if (!this.#connected) {
      this.#pendingKeys.push(entry);
      if (event.own) {
        this.#ownKeyPending = true;
        this.#ownKey?.resolve();
        this.#ownKey = undefined;
      }
      return;
    }

    void this.#media?.setEncryptionKey(entry).then(
      () => {
        if (event.own) this.#markReady();
      },
      () => {
        this.#ownKey?.reject(new Error('own-key-failed'));
        this.#ownKey = undefined;
      }
    );
  }

  #markReady(): void {
    this.mediaReady = true;
    this.#ownKey?.resolve();
    this.#ownKey = undefined;
  }

  #waitForOwnKey(): Promise<void> {
    if (this.mediaReady || this.#ownKeyPending) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#ownKey = undefined;
        reject(new Error('own-key-timeout'));
      }, OWN_KEY_TIMEOUT_MS);

      this.#ownKey = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  async #teardown(): Promise<void> {
    this.#ownKey?.reject(new Error('cancelled'));
    this.#ownKey = undefined;

    try {
      await this.#media?.disconnect();
    } catch {
      ignoreError();
    }

    const session = this.#session;
    if (session !== undefined) {
      try {
        await this.#client.leaveCall(session);
      } catch {
        ignoreError();
      }
    }

    this.#unsubscribeKeys?.();
    this.#unsubscribeKeys = undefined;
    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#lease?.release();
    this.#lease = undefined;
    this.#media = undefined;
    this.#livekit = undefined;
    this.#grant = undefined;
    this.#session = undefined;
    this.#buffer = [];
    this.#pendingKeys = [];
    this.#ownKeyPending = false;
    this.#connected = false;
    this.members = [];
    this.transport = idleTransportState();
    this.mediaReady = false;
    this.encryptsMedia = false;
  }
}

export const [useCallSession, provideCallSession] = createContext<CallSession>();
