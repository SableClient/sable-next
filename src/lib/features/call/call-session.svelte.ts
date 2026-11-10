import { rememberScreenAudioChoice, screenAudioSupported } from '#lib/platform/screen-audio.js';
import type { ScreenAudioChoice } from '#lib/platform/screen-audio-stream.js';
import { createContext } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { DesktopCallShortcutBackend } from '#lib/platform/call-shortcut-types.js';

import type { CallMemberView, CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { joinCall, type CallGrant } from '#lib/core/api/calls.js';

import type {
  CallEncryptionKey,
  CallParticipant,
  CallTransport,
  CallTransportCapabilities,
  CallTransportState,
} from './call-transport';
import {
  decodeCallKey,
  idleTransportState,
  ignoreError,
  ScreenAudioError,
  NativeCallFailure,
  TransportDisconnectError,
} from './call-transport';
import { acquireCallOwner, type CallOwnerLease } from './call-owner';
import type { LivekitTransport } from './livekit-transport';
import { createNativeTransport } from './native-transport';
import { hasNativeCalls, nativeCallOwnsAudio, setNativeCallAudio } from '#lib/platform/calls.js';
import { commandErrorCode } from './command-error';
import { CallTelemetry } from './call-telemetry';
import { recordCallDebug, type CallDebug } from './call-debug.svelte.js';
import { cameraVisible, screenShareVisible, type CallPin } from './call-layout';
import { participantKeys } from './participant-keys';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import { type CallInputMode } from '#lib/settings/definitions.js';
import { DEVICE_PREFERENCE } from './devices';
import type { CallBackendGrant, CallRemoteVideoOverlay, CallVideoOverlay } from './call-transport';
import { playSound, releaseNotificationAudio } from '../notifications/sound';

export type CallLifecycle = 'idle' | 'joining' | 'connecting' | 'active' | 'leaving' | 'failed';

export type CallFailure = 'busy' | 'no-focus' | 'e2ee-unsupported' | 'e2ee-failed' | 'setup-failed';

export type CallMedia = { microphone: boolean; camera: boolean };

export type CallVoiceState = {
  speaking: boolean;
  muted: boolean;
  camera: boolean;
  screen: boolean;
  deafened: boolean;
};

export type CallDeviceError = 'microphone' | 'camera' | 'screen' | 'screenAudio';

const OWN_KEY_TIMEOUT_MS = 10_000;
const DEVICE_ERROR_TIMEOUT_MS = 5_000;
export const TALK_RELEASE_DELAY_MS = 150;

type PendingEvent = Extract<
  CoreEvent,
  { type: 'call_encryption_key' | 'call_members' | 'call_backends' | 'call_signaling_error' }
>;

const isCallEvent = (event: CoreEvent): event is PendingEvent =>
  event.type === 'call_encryption_key' ||
  event.type === 'call_members' ||
  event.type === 'call_backends' ||
  event.type === 'call_signaling_error';

export function voiceStates(
  members: readonly CallMemberView[],
  participants: readonly CallParticipant[],
  deafened: boolean
): Map<string, CallVoiceState> {
  /* eslint-disable svelte/prefer-svelte-reactivity -- rebuilt whole on every change, never mutated after */
  const byIdentity = new Map(members.map((member) => [member.identity, member]));
  const devices = new Map<string, { member: CallMemberView; state: CallVoiceState }>();
  for (const participant of participants) {
    const member = byIdentity.get(participant.identity);
    if (!member) continue;
    const previous = devices.get(participant.identity)?.state;
    devices.set(participant.identity, {
      member,
      state: {
        speaking: (previous?.speaking ?? false) || participant.speaking === true,
        muted: (previous?.muted ?? true) && (participant.microphone?.muted ?? true),
        camera: (previous?.camera ?? false) || cameraVisible(participant),
        screen: (previous?.screen ?? false) || screenShareVisible(participant),
        deafened: (previous?.deafened ?? false) || (participant.local === true && deafened),
      },
    });
  }
  const ordered = [...devices.values()].sort((left, right) =>
    left.member.device_id.localeCompare(right.member.device_id)
  );
  const keys = participantKeys(ordered.map(({ member }) => member.user_id));
  return new Map(ordered.map(({ state }, index) => [keys[index] ?? '', state]));
  /* eslint-enable svelte/prefer-svelte-reactivity */
}

const isLivekit = (transport: CallTransport): transport is LivekitTransport =>
  'keyProvider' in transport;

export type CallSessionDeps = {
  createTransport?: (encryptMedia: boolean) => CallTransport;
  e2eeSupported?: () => boolean;
  roomName?: (roomId: string) => string | null | undefined;
};

export class CallSession {
  lifecycle = $state<CallLifecycle>('idle');
  failure = $state<CallFailure | null>(null);
  roomId = $state<string | null>(null);
  members = $state.raw<CallMemberView[]>([]);
  transport = $state.raw<CallTransportState>(idleTransportState());
  mediaReady = $state(false);
  encryptsMedia = $state(false);
  deafened = $state(false);
  microphoneEnabled = $state(false);
  inputMode = $state<CallInputMode>(
    hasNativeCalls() ? 'voice-activity' : preferences.callInputMode
  );
  desktopShortcutStatus = $state<'inactive' | 'error' | DesktopCallShortcutBackend>('inactive');
  connectedAt = $state<number | null>(null);
  layout = $state.raw<CallPin>({ pinned: null, gridForced: false });
  watchedScreenShareIds = $state.raw<string[]>([]);
  views = $state(0);
  deviceError = $state<CallDeviceError | null>(null);
  listenOnly = $state(false);
  #deviceErrorTimer: ReturnType<typeof setTimeout> | undefined;
  choosingScreenAudio = $state(false);

  toggleWatchScreenShare(trackId: string): void {
    this.watchedScreenShareIds = this.watchedScreenShareIds.includes(trackId)
      ? this.watchedScreenShareIds.filter((id) => id !== trackId)
      : [...this.watchedScreenShareIds, trackId];
  }

  get startedAt(): number | null {
    if (this.connectedAt === null) return null;
    return this.members.reduce(
      (earliest, member) =>
        member.joined_ts > 0 ? Math.min(earliest, member.joined_ts) : earliest,
      this.connectedAt
    );
  }

  readonly #client: CoreClient;
  readonly #deps: CallSessionDeps;
  #media = $state.raw<CallTransport | undefined>(undefined);
  #livekit = $state.raw<LivekitTransport | undefined>(undefined);
  #grant: CallGrant | undefined;
  #session: number | undefined;
  #screenSharing = false;
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
  #latestBackends:
    | { revision: number; publisherId: string; backends: CallBackendGrant[] }
    | undefined;
  #transportConnection: CallTransportState['connection'] | undefined;
  #transportErrorCode: string | undefined;
  #teardownPromise: Promise<void> | undefined;
  #attemptGeneration = 0;
  #backendEnded = false;
  #ownKey: { resolve: () => void; reject: (error: Error) => void } | undefined;
  #telemetry: CallTelemetry | undefined;
  #lastJoin: { roomId: string; media: CallMedia; serviceUrl: string | null } | undefined;
  #talkSources = new SvelteSet<string>();
  #talkReleases = new SvelteMap<
    string,
    { timer: ReturnType<typeof setTimeout>; done: () => void }
  >();
  #microphoneUpdate = Promise.resolve();

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

  get localVideo(): CallVideoOverlay | undefined {
    return this.#media?.capabilities.localVideo;
  }

  get remoteVideo(): CallRemoteVideoOverlay | undefined {
    return this.#media?.capabilities.remoteVideo;
  }

  get audioRoutes(): CallTransportCapabilities['audioRoutes'] {
    return this.#media?.capabilities.audioRoutes;
  }

  get audioInputs(): CallTransportCapabilities['audioInputs'] {
    return this.#media?.capabilities.audioInputs;
  }

  async selectAudioRoute(routeId: string): Promise<void> {
    await this.#media?.capabilities.audioRoutes?.select(routeId);
  }

  get canSwitchCamera(): boolean {
    return this.#media?.capabilities.camera !== undefined;
  }

  readonly voiceStates = $derived.by(() => {
    const { self, participants } = this.transport;
    return voiceStates(this.members, self ? [self, ...participants] : participants, this.deafened);
  });

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
    this.#lastJoin = { roomId, media, serviceUrl };
    this.microphoneEnabled = media.microphone;
    this.inputMode = hasNativeCalls() ? 'voice-activity' : preferences.callInputMode;
    setPreference('callMicrophoneMuted', !media.microphone);
    this.layout = { pinned: null, gridForced: false };
    this.watchedScreenShareIds = [];
    this.clearDeviceError();
    const attempt = ++this.#attemptGeneration;
    const telemetry = new CallTelemetry({
      'call.microphone_requested': media.microphone,
      'call.camera_requested': media.camera,
      'call.native_expected': hasNativeCalls(),
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
        joinCall(
          this.#client.rpc,
          roomId,
          serviceUrl,
          hasNativeCalls()
            ? 'legacy'
            : preferences.callMode === 'auto'
              ? null
              : preferences.callMode,
          media.camera ? 'video' : 'audio'
        )
      );
      if (attempt !== this.#attemptGeneration) {
        await this.#client.rpc.calls.leave({ session: grant.session }).catch(ignoreError);
        return;
      }
      this.#session = grant.session;

      const supported =
        this.#deps.e2eeSupported ?? (await import('./key-provider')).isCallE2eeSupported;
      if (attempt !== this.#attemptGeneration) return;
      if (grant.encrypt_media && !supported()) {
        telemetry.terminal('call.encryption.unsupported', new Error('e2ee-unsupported'));
        await this.#teardown();
        this.#fail('e2ee-unsupported');
        telemetry.finish('failed');
        return;
      }

      const { transport, kind: transportKind } = await telemetry.step(
        'call.transport.create',
        async (): Promise<{ transport: CallTransport; kind: CallDebug['transport'] }> => {
          const injected = this.#deps.createTransport?.(grant.encrypt_media);
          if (injected) {
            const kind = isLivekit(injected)
              ? 'livekit-web'
              : grant.backends.length
                ? 'livekit-multi'
                : 'native';
            return { transport: injected, kind };
          }
          if (grant.mode === 'legacy') {
            const native = await createNativeTransport(
              String(grant.session),
              grant.identity,
              this.#deps.roomName?.(roomId) ?? roomId
            );
            if (native) return { transport: native, kind: 'native' };
          }
          if (grant.backends.length) {
            const multi = await import('./multi-sfu-transport');
            return {
              transport: multi.createMultiSfuTransport(grant.encrypt_media, telemetry),
              kind: 'livekit-multi',
            };
          }
          const web = await import('./livekit-transport');
          return {
            transport: web.createLivekitTransport({
              encryptMedia: grant.encrypt_media,
              telemetry,
            }),
            kind: 'livekit-web',
          };
        }
      );
      if (attempt !== this.#attemptGeneration) {
        await transport.disconnect().catch(ignoreError);
        return;
      }
      this.#media = transport;
      this.#livekit = isLivekit(transport) ? transport : undefined;
      setNativeCallAudio(transportKind === 'native');
      if (nativeCallOwnsAudio()) releaseNotificationAudio();
      if (hasNativeCalls() && transportKind !== 'native') {
        telemetry.degraded('call.native.skipped', new Error('native-transport-skipped'), {
          'call.mode': grant.mode,
          'call.transport': transportKind,
        });
      }
      recordCallDebug({
        requested: preferences.callMode,
        nativeForced: hasNativeCalls(),
        mode: grant.mode,
        reason: grant.mode_reason,
        stickyAvailable: grant.sticky_available,
        peerModes: grant.peer_modes,
        transport: transportKind,
        backendCount: grant.backends.length,
        encrypted: grant.encrypt_media,
      });
      telemetry.event('call.transport.selected', {
        'call.transport': transportKind,
        'call.mode': grant.mode,
        'call.mode_reason': grant.mode_reason,
        'call.sticky_available': grant.sticky_available,
        'call.peer_modes': grant.peer_modes.join(',') || 'none',
        'call.backend_count': grant.backends.length,
        'call.encryption_requested': grant.encrypt_media,
      });
      this.#unsubscribeTransport = transport.subscribe((state) => {
        this.transport = state;
        const sharing = state.connection === 'connected' && state.screenShareEnabled;
        if (sharing !== this.#screenSharing && this.#session !== undefined) {
          this.#screenSharing = sharing;
          void this.#client.rpc.calls
            .setScreenSharing({ session: this.#session, active: sharing })
            .catch(ignoreError);
        }
        if (state.connection !== this.#transportConnection) {
          this.#transportConnection = state.connection;
          telemetry.event('call.transport.state', { 'call.connection': state.connection });
        }
        if (state.errorCode !== this.#transportErrorCode) {
          this.#transportErrorCode = state.errorCode;
          if (state.errorCode !== undefined) {
            telemetry.degraded('call.native.error', new NativeCallFailure(state.errorCode), {
              'call.connection': state.connection,
              'call.microphone_effective': state.microphoneEnabled,
            });
          }
        }
        if (state.connection === 'disconnected' && this.lifecycle === 'active') {
          telemetry.terminal(
            'call.transport.disconnected',
            new TransportDisconnectError(state.disconnectReason ?? 'UNKNOWN')
          );
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
          telemetry.failure('call.encryption.key_import', new Error('key-import-failed'));
          this.#ownKey?.reject(new Error('own-key-failed'));
          this.#ownKey = undefined;
          return;
        }
        if (keyState.ready) this.#markReady();
      });

      this.#grant = grant;
      this.listenOnly = !grant.can_publish;

      this.encryptsMedia = grant.encrypt_media;
      this.mediaReady = false;
      this.#drain();

      if (grant.encrypt_media) {
        await telemetry.step('call.encryption.wait_for_key', () => this.#waitForOwnKey());
      }
      if (attempt !== this.#attemptGeneration) return;

      this.lifecycle = 'connecting';
      const encryptionKeys = this.#pendingKeys.splice(0, this.#pendingKeys.length);
      const connectBackends = this.#latestBackends?.backends ?? grant.backends;
      const connectPublisherId = this.#latestBackends?.publisherId ?? grant.publisher_id;
      this.#keysAccepted = true;
      await telemetry.step('call.transport.connect', async () => {
        await transport.connect({
          url: grant.url,
          token: grant.jwt,
          microphoneEnabled: this.#canTransmit(),
          microphoneStandby:
            this.microphoneEnabled && !this.listenOnly && this.inputMode === 'push-to-talk',
          cameraEnabled: media.camera && !this.listenOnly,
          encryptionKeys: encryptionKeys.map(({ key }) => key),
          publisherId: connectPublisherId,
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
        await transport.reconcileBackends?.(snapshot.backends, snapshot.publisherId);
      }
      if (attempt !== this.#attemptGeneration) return;
      if (this.#ownKeyPending) this.#markReady();
      this.mediaReady = true;

      this.lifecycle = 'active';
      if (this.transport.microphoneEnabled !== this.#canTransmit()) {
        await this.#setMicrophone(this.#canTransmit());
        if (attempt !== this.#attemptGeneration) return;
      }
      this.connectedAt = Date.now();
      this.#cue('call_join');
      telemetry.finish('connected');
    } catch (error) {
      if (attempt !== this.#attemptGeneration) return;
      telemetry.terminal('call.join', error);
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
    this.connectedAt = null;
    this.clearDeviceError();
    this.#cue('call_leave');
  }

  clearFailure(): void {
    if (this.lifecycle !== 'failed') return;
    this.lifecycle = 'idle';
    this.failure = null;
    this.roomId = null;
  }

  async retry(): Promise<void> {
    const last = this.#lastJoin;
    if (this.lifecycle !== 'failed' || !last) return;
    await this.join(last.roomId, last.media, last.serviceUrl);
  }

  clearDeviceError(): void {
    clearTimeout(this.#deviceErrorTimer);
    this.#deviceErrorTimer = undefined;
    this.deviceError = null;
  }

  async #device(kind: CallDeviceError, action: () => Promise<void> | undefined): Promise<boolean> {
    if (this.listenOnly) return false;
    const attempt = this.#attemptGeneration;
    try {
      await action();
      if (this.deviceError === kind) this.clearDeviceError();
      return true;
    } catch (error) {
      if (attempt !== this.#attemptGeneration || !this.active || this.lifecycle === 'leaving')
        return false;
      // A cancelled screen picker: WebView2 and browsers reject with NotAllowedError, Electron with AbortError.
      if (
        kind === 'screen' &&
        error instanceof Error &&
        (error.name === 'NotAllowedError' || error.name === 'AbortError')
      )
        return false;
      this.clearDeviceError();
      this.deviceError = error instanceof ScreenAudioError ? 'screenAudio' : kind;
      this.#deviceErrorTimer = setTimeout(() => {
        this.clearDeviceError();
      }, DEVICE_ERROR_TIMEOUT_MS);
      return error instanceof ScreenAudioError;
    }
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    this.microphoneEnabled = enabled;
    if (enabled && this.deafened) {
      this.deafened = false;
    }
    setPreference('callMicrophoneMuted', !enabled);
    await this.#setMicrophone(this.#canTransmit());
    this.#cue(enabled ? 'mic_on' : 'mic_off');
  }

  toggleMicrophone(): Promise<void> {
    return this.setMicrophoneEnabled(!this.microphoneEnabled || this.deafened);
  }

  async setTalking(held: boolean, source = 'keyboard'): Promise<void> {
    const release = this.#talkReleases.get(source);
    if (held) {
      if (release) {
        clearTimeout(release.timer);
        this.#talkReleases.delete(source);
        release.done();
        return;
      }
      if (
        this.lifecycle !== 'active' ||
        !this.mediaReady ||
        this.listenOnly ||
        this.deafened ||
        this.inputMode !== 'push-to-talk'
      )
        return;
      if (this.#talkSources.has(source)) return;
      this.#talkSources.add(source);
    } else {
      if (!this.#talkSources.has(source) || release) return;
      const released = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.#talkReleases.delete(source);
          resolve(this.#talkSources.delete(source));
        }, TALK_RELEASE_DELAY_MS);
        this.#talkReleases.set(source, {
          timer,
          done: () => {
            resolve(false);
          },
        });
      });
      if (!released) return;
    }
    if (this.microphoneEnabled) await this.#setMicrophone(this.#canTransmit());
  }

  setInputMode(mode: CallInputMode): void {
    if (hasNativeCalls() || this.inputMode === mode) return;
    this.inputMode = mode;
    this.#clearTalking();
    if (this.lifecycle === 'active') void this.#setMicrophone(this.#canTransmit());
  }

  #clearTalking(): void {
    for (const { timer, done } of this.#talkReleases.values()) {
      clearTimeout(timer);
      done();
    }
    this.#talkReleases.clear();
    this.#talkSources.clear();
  }

  #canTransmit(): boolean {
    return (
      this.microphoneEnabled &&
      !this.listenOnly &&
      !this.deafened &&
      (this.inputMode !== 'push-to-talk' || this.#talkSources.size > 0)
    );
  }

  #setMicrophone(enabled: boolean): Promise<void> {
    const media = this.#media;
    const attempt = this.#attemptGeneration;
    this.#microphoneUpdate = this.#microphoneUpdate.then(async () => {
      if (
        media !== this.#media ||
        attempt !== this.#attemptGeneration ||
        this.lifecycle !== 'active' ||
        enabled !== this.#canTransmit()
      )
        return;
      await this.#device('microphone', () => media?.setMicrophoneEnabled(enabled));
    });
    return this.#microphoneUpdate;
  }

  async setParticipantVolume(identity: string, volume: number, screen = false): Promise<void> {
    await this.#media?.setParticipantVolume?.(identity, volume, screen);
  }

  setDeafened(deafened: boolean): void {
    if (deafened === this.deafened) return;
    this.#clearTalking();
    this.deafened = deafened;
    if (!this.#media) return;
    this.#cue(deafened ? 'deafen_on' : 'deafen_off');
    if (this.microphoneEnabled) void this.#setMicrophone(this.#canTransmit());
  }

  async switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    setPreference(DEVICE_PREFERENCE[kind], deviceId);
    const error = kind === 'videoinput' ? 'camera' : 'microphone';
    await this.#device(error, async () => {
      await Promise.all(
        this.rooms.map(({ room }) => room.switchActiveDevice(kind, deviceId || 'default'))
      );
    });
  }

  async switchCamera(): Promise<void> {
    await this.#device('camera', () => this.#media?.capabilities.camera?.switch());
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.#device('camera', () => this.#media?.setCameraEnabled(enabled));
    this.#cue(enabled ? 'camera_on' : 'camera_off');
  }

  async toggleScreenShare(): Promise<void> {
    if (this.transport.screenShareEnabled) {
      await this.#stopScreenShare();
      this.#cue('screenshare_stop');
      return;
    }
    if (screenAudioSupported()) this.choosingScreenAudio = true;
    else await this.#shareScreen(undefined);
  }

  async shareScreenWith(audio: ScreenAudioChoice): Promise<void> {
    this.choosingScreenAudio = false;
    rememberScreenAudioChoice(audio);
    await this.#shareScreen(audio);
  }

  async #shareScreen(audio: ScreenAudioChoice | undefined) {
    const shared = await this.#device('screen', () =>
      this.#media?.capabilities.screenShare?.setEnabled(true, audio)
    );
    if (shared) this.#cue('screenshare_start');
  }

  async #stopScreenShare(): Promise<void> {
    await this.#device('screen', () => this.#media?.capabilities.screenShare?.setEnabled(false));
  }

  #classify(error: unknown): CallFailure {
    if (error instanceof Error && error.message === 'own-key-timeout') return 'e2ee-failed';
    return commandErrorCode(error) === 'no_call_focus' ? 'no-focus' : 'setup-failed';
  }

  #fail(failure: CallFailure): void {
    this.failure = failure;
    this.lifecycle = 'failed';
    this.connectedAt = null;
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
      const signalingError = new Error('signaling-error');
      if (!event.fatal || this.lifecycle === 'idle' || this.lifecycle === 'leaving') {
        this.#telemetry?.failure(`call.signaling.${event.stage}`, signalingError);
        return;
      }
      this.#telemetry?.terminal(`call.signaling.${event.stage}`, signalingError);
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
      this.#latestBackends = {
        revision: event.revision,
        publisherId: event.publisher_id,
        backends: event.backends,
      };
      if (!this.#connected) return;
      this.#backendsRevision = event.revision;
      const telemetry = this.#telemetry;
      void this.#media
        ?.reconcileBackends?.(event.backends, event.publisher_id)
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
      void provider.setKey(entry, event.own).catch((error: unknown) => {
        this.#telemetry?.failure('call.encryption.key', error);
      });
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
      (error: unknown) => {
        this.#telemetry?.failure('call.encryption.key_import', error);
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

  #cue(name: Parameters<typeof playSound>[0]): void {
    void playSound(name).catch((error: unknown) => {
      console.warn('[sable call] sound not played', name, error);
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
    this.desktopShortcutStatus = 'inactive';
    this.#clearTalking();
    this.#microphoneUpdate = Promise.resolve();
    this.#ownKey?.reject(new Error('cancelled'));
    this.#ownKey = undefined;

    try {
      await this.#telemetry?.step(
        'call.transport.disconnect',
        () => this.#media?.disconnect() ?? Promise.resolve()
      );
    } catch (error) {
      this.#telemetry?.failure('call.transport.disconnect', error);
    }
    setNativeCallAudio(false);

    const session = this.#session;
    if (session !== undefined && !this.#backendEnded) {
      try {
        await this.#telemetry?.step('call.signaling.leave', () =>
          this.#client.rpc.calls.leave({ session })
        );
      } catch (error) {
        this.#telemetry?.failure('call.signaling.leave', error);
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
    this.listenOnly = false;
    this.choosingScreenAudio = false;
    this.#session = undefined;
    this.#screenSharing = false;
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
    this.#transportErrorCode = undefined;
    this.members = [];
    this.transport = idleTransportState();
    this.deafened = false;
    this.mediaReady = false;
    this.encryptsMedia = false;
    this.#telemetry?.event('call.cleanup');
  }
}

export const [useCallSession, provideCallSession] = createContext<CallSession>();
