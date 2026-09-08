import { createContext } from 'svelte';

import type { CallMemberView, CoreEvent } from '#src/generated/protocol';
import type { CallGrant, CoreClient } from '#lib/core/client.svelte.js';

import type { CallEncryptionKey, CallTransport, CallTransportState } from './call-transport';
import { decodeCallKey, idleTransportState, ignoreError } from './call-transport';
import { acquireCallOwner, type CallOwnerLease } from './call-owner';
import type { LivekitTransport } from './livekit-transport';
import { createNativeTransport } from './native-transport';
import { hasNativeCalls } from '#lib/platform/calls.js';
import { commandErrorCode } from './command-error';
import { CallTelemetry } from './call-telemetry';
import type { CallBackendGrant } from './call-transport';

export type CallLifecycle = 'idle' | 'joining' | 'connecting' | 'active' | 'leaving' | 'failed';

export type CallFailure = 'busy' | 'no-focus' | 'e2ee-unsupported' | 'e2ee-failed' | 'setup-failed';

export type CallMedia = { microphone: boolean; camera: boolean };

const OWN_KEY_TIMEOUT_MS = 10_000;

type PendingEvent = Extract<
  CoreEvent,
  { type: 'call_encryption_key' | 'call_members' | 'call_backends' | 'call_signaling_error' }
>;

const isCallEvent = (event: CoreEvent): event is PendingEvent =>
  event.type === 'call_encryption_key' ||
  event.type === 'call_members' ||
  event.type === 'call_backends' ||
  event.type === 'call_signaling_error';

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
  #pendingKeys: { key: CallEncryptionKey; backendId?: string }[] = [];
  #ownKeyPending = false;
  #keysAccepted = false;
  #connected = false;
  #keyCount = 0;
  #backendsRevision = -1;
  #latestBackends: { revision: number; backends: CallBackendGrant[] } | undefined;
  #transportConnection: CallTransportState['connection'] | undefined;
  #teardownPromise: Promise<void> | undefined;
  #attemptGeneration = 0;
  #backendEnded = false;
  #ownKey: { resolve: () => void; reject: (error: Error) => void } | undefined;
  #telemetry: CallTelemetry | undefined;

  constructor(client: CoreClient, deps: CallSessionDeps = {}) {
    this.#client = client;
    this.#deps = deps;
  }

  get room(): LivekitTransport | undefined {
    return this.#livekit;
  }

  get rooms() {
    void this.transport;
    return (
      this.#media?.rooms?.() ??
      (this.#livekit ? [{ backendId: 'legacy', room: this.#livekit.room }] : [])
    );
  }

  roomFor(backendId: string | undefined) {
    return this.#media?.roomFor?.(backendId) ?? this.#livekit?.room;
  }

  get telemetry(): CallTelemetry | undefined {
    return this.#telemetry;
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
    const attempt = ++this.#attemptGeneration;
    const telemetry = new CallTelemetry({
      'call.microphone_requested': media.microphone,
      'call.camera_requested': media.camera,
    });
    this.#telemetry = telemetry;
    this.roomId = roomId;
    this.lifecycle = 'joining';
    this.failure = null;
    this.mediaReady = false;

    this.#buffer = [];
    this.#backendEnded = false;
    this.#unsubscribe = this.#client.subscribeEvents((event) => {
      this.#onCoreEvent(event);
    });

    try {
      const grant = await telemetry.step('call.signaling.join', () =>
        this.#client.commands.joinCall(roomId, serviceUrl, hasNativeCalls() ? 'legacy' : null)
      );
      if (attempt !== this.#attemptGeneration) {
        await this.#client.commands.leaveCall(grant.session).catch(ignoreError);
        return;
      }
      this.#session = grant.session;

      const supported =
        this.#deps.e2eeSupported ?? (await import('./key-provider')).isCallE2eeSupported;
      if (attempt !== this.#attemptGeneration) return;
      if (grant.encryptMedia && !supported()) {
        telemetry.failure('call.encryption.unsupported', new Error('OperationError'));
        await this.#teardown();
        this.#fail('e2ee-unsupported');
        telemetry.finish('failed');
        return;
      }

      const transport = await telemetry.step(
        'call.transport.create',
        async () =>
          this.#deps.createTransport?.(grant.encryptMedia) ??
          (grant.mode === undefined || grant.mode === 'legacy'
            ? await createNativeTransport(String(grant.session))
            : null) ??
          (grant.backends?.length
            ? (await import('./multi-sfu-transport')).createMultiSfuTransport(
                grant.encryptMedia,
                telemetry
              )
            : (await import('./livekit-transport')).createLivekitTransport({
                encryptMedia: grant.encryptMedia,
                telemetry,
              }))
      );
      if (attempt !== this.#attemptGeneration) {
        await transport.disconnect().catch(ignoreError);
        return;
      }
      this.#media = transport;
      this.#livekit = isLivekit(transport) ? transport : undefined;
      telemetry.event('call.transport.selected', {
        'call.transport': this.#livekit
          ? 'livekit-web'
          : grant.backends?.length
            ? 'livekit-multi'
            : 'native',
        'call.mode': grant.mode ?? 'legacy',
        'call.backend_count': grant.backends?.length ?? 0,
        'call.encryption_requested': grant.encryptMedia,
      });
      this.#unsubscribeTransport = transport.subscribe((state) => {
        this.transport = state;
        if (state.connection !== this.#transportConnection) {
          this.#transportConnection = state.connection;
          telemetry.event('call.transport.state', { 'call.connection': state.connection });
        }
        if (state.connection === 'disconnected' && this.lifecycle === 'active') {
          telemetry.failure('call.transport.disconnected', new Error('OperationError'));
          this.lifecycle = 'leaving';
          void this.#teardown().then(() => {
            if (this.lifecycle === 'leaving') {
              this.#fail('setup-failed');
              telemetry.finish('failed');
            }
          });
        }
      });

      const provider = this.#livekit?.keyProvider;
      this.#unsubscribeKeys = provider?.subscribe((keyState) => {
        if (keyState.lastFailure) {
          telemetry.event('call.encryption.key_import', {
            'call.key_import_failure': keyState.lastFailure,
          });
          telemetry.failure('call.encryption.key_import', new Error('OperationError'));
          this.#ownKey?.reject(new Error('own-key-failed'));
          this.#ownKey = undefined;
          return;
        }
        if (keyState.ready) this.#markReady();
      });

      this.#grant = grant;

      this.encryptsMedia = grant.encryptMedia;
      this.mediaReady = false;
      this.#drain();

      if (grant.encryptMedia) {
        await telemetry.step('call.encryption.wait_for_key', () => this.#waitForOwnKey());
      }
      if (attempt !== this.#attemptGeneration) return;

      this.lifecycle = 'connecting';
      const encryptionKeys = this.#pendingKeys.splice(0, this.#pendingKeys.length);
      const connectBackends = this.#latestBackends?.backends ?? grant.backends;
      this.#keysAccepted = true;
      await telemetry.step('call.transport.connect', async () => {
        await transport.connect({
          url: grant.url,
          token: grant.jwt,
          microphoneEnabled: media.microphone,
          cameraEnabled: media.camera,
          encryptionKeys: encryptionKeys.map(({ key }) => key),
          publisherId: grant.publisherId,
          backends: connectBackends,
        });
        if (transport.getState().connection !== 'connected') {
          throw new Error('transport-not-connected');
        }
      });
      if (attempt !== this.#attemptGeneration) {
        await transport.disconnect().catch(ignoreError);
        return;
      }
      this.#connected = true;
      if (attempt !== this.#attemptGeneration) return;
      if (this.#latestBackends && this.#latestBackends.revision > this.#backendsRevision) {
        const snapshot = this.#latestBackends;
        this.#backendsRevision = snapshot.revision;
        await transport.reconcileBackends?.(snapshot.backends);
      }
      if (attempt !== this.#attemptGeneration) return;
      if (this.#ownKeyPending) this.#markReady();
      this.mediaReady = true;

      this.lifecycle = 'active';
      telemetry.finish('connected');
    } catch (error) {
      if (attempt !== this.#attemptGeneration) return;
      telemetry.failure('call.join', error);
      await this.#teardown();
      this.#fail(this.#classify(error));
      telemetry.finish('failed');
    }
  }

  async leave(): Promise<void> {
    if (this.lifecycle === 'idle') return;
    ++this.#attemptGeneration;
    this.lifecycle = 'leaving';
    await this.#teardown();
    this.#telemetry?.finish('cancelled');
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

    if (event.type === 'call_signaling_error') {
      this.#telemetry?.failure(`call.signaling.${event.stage}`, new Error('OperationError'));
      if (!event.fatal || this.lifecycle === 'idle' || this.lifecycle === 'leaving') return;
      ++this.#attemptGeneration;
      this.#backendEnded = true;
      this.lifecycle = 'leaving';
      void this.#teardown().then(() => {
        if (this.lifecycle === 'leaving') {
          this.#fail('setup-failed');
          this.#telemetry?.finish('failed');
        }
      });
      return;
    }

    if (event.type === 'call_members') {
      this.members = event.members;
      this.#telemetry?.event('call.members', { 'call.member_count': event.members.length });
      return;
    }

    if (event.type === 'call_backends') {
      if (
        event.revision <= this.#backendsRevision ||
        event.revision <= (this.#latestBackends?.revision ?? -1)
      )
        return;
      this.#latestBackends = { revision: event.revision, backends: event.backends };
      if (!this.#connected) return;
      this.#backendsRevision = event.revision;
      const telemetry = this.#telemetry;
      void this.#media
        ?.reconcileBackends?.(event.backends)
        .catch((error: unknown) => telemetry?.failure('call.backend.reconcile', error));
      return;
    }

    const key = decodeCallKey(event.key);
    if (!key) return;

    const backendId = event.backend_id ?? undefined;
    const entry = { identity: event.identity, keyIndex: event.key_index, key, backendId };
    this.#keyCount += 1;
    this.#telemetry?.event('call.encryption.key_received', {
      'call.key_count': this.#keyCount,
      'call.own_key': event.own,
    });

    const provider = this.#livekit?.keyProvider;
    if (provider) {
      provider.setKey(entry, event.own);
      return;
    }

    if (!this.#keysAccepted) {
      this.#pendingKeys.push({ key: entry });
      if (event.own) {
        this.#ownKeyPending = true;
        this.#ownKey?.resolve();
        this.#ownKey = undefined;
      }
      return;
    }

    void this.#media?.setEncryptionKey(entry, backendId).then(
      () => {
        if (event.own) this.#markReady();
      },
      () => {
        this.#telemetry?.failure('call.encryption.key_import', new Error('OperationError'));
        this.#ownKey?.reject(new Error('own-key-failed'));
        this.#ownKey = undefined;
      }
    );
  }

  #markReady(): void {
    if (!this.#connected) {
      this.#ownKeyPending = true;
      this.#ownKey?.resolve();
      this.#ownKey = undefined;
      return;
    }
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
    if (this.#teardownPromise) return this.#teardownPromise;

    this.#teardownPromise = this.#performTeardown();
    try {
      await this.#teardownPromise;
    } finally {
      this.#teardownPromise = undefined;
    }
  }

  async #performTeardown(): Promise<void> {
    this.#ownKey?.reject(new Error('cancelled'));
    this.#ownKey = undefined;

    try {
      await this.#telemetry?.step(
        'call.transport.disconnect',
        () => this.#media?.disconnect() ?? Promise.resolve()
      );
    } catch (error) {
      this.#telemetry?.failure('call.transport.disconnect', error);
      ignoreError();
    }

    const session = this.#session;
    if (session !== undefined && !this.#backendEnded) {
      try {
        await this.#telemetry?.step('call.signaling.leave', () =>
          this.#client.commands.leaveCall(session)
        );
      } catch (error) {
        this.#telemetry?.failure('call.signaling.leave', error);
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
    this.#keyCount = 0;
    this.#backendsRevision = -1;
    this.#latestBackends = undefined;
    this.#keysAccepted = false;
    this.#connected = false;
    this.#backendEnded = false;
    this.#transportConnection = undefined;
    this.members = [];
    this.transport = idleTransportState();
    this.mediaReady = false;
    this.encryptsMedia = false;
    this.#telemetry?.event('call.cleanup');
  }
}

export const [useCallSession, provideCallSession] = createContext<CallSession>();
