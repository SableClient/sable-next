import type { CoreEvent } from '@/generated/CoreEvent';
import type { DeviceView } from '@/generated/DeviceView';
import type { EncryptionStatusView } from '@/generated/EncryptionStatusView';
import type { AuthIntent } from '@/generated/AuthIntent';
import type { LoginFlowsView } from '@/generated/LoginFlowsView';
import type { RegistrationFlowsView } from '@/generated/RegistrationFlowsView';
import type { MemberView } from '@/generated/MemberView';
import type { RoomSummary } from '@/generated/RoomSummary';
import type { SessionInfo } from '@/generated/SessionInfo';
import type { SubscriptionId } from '@/generated/SubscriptionId';
import type { PaginationDirection } from '@/generated/PaginationDirection';
import type { ProfileView } from '@/generated/ProfileView';
import type { TimelineItemView } from '@/generated/TimelineItemView';
import type { RegistrationResultView } from '@/generated/RegistrationResultView';
import type { VerificationView } from '@/generated/VerificationView';

import { createTransport } from '../../transport/create';
import type { Transport } from '../../transport';
import { CoreError } from '../../transport';

type WellKnownResponse = { 'm.homeserver'?: { base_url?: unknown } };
const maxAttachmentBytes = 100 * 1024 * 1024;
let resolvedHomeservers: Record<string, string> = {};

async function resolveHomeserverInPage(homeserver: string): Promise<string> {
  const cached = resolvedHomeservers[homeserver];
  if (cached) return cached;

  let origin: URL;
  try {
    origin = new URL(homeserver.includes('://') ? homeserver : `https://${homeserver}`);
  } catch {
    return homeserver;
  }

  try {
    const response = await fetch(new URL('/.well-known/matrix/client', origin), { mode: 'cors' });
    if (!response.ok) return homeserver;
    const body = (await response.json()) as WellKnownResponse;
    const baseUrl = body['m.homeserver']?.base_url;
    if (typeof baseUrl !== 'string') return homeserver;
    const resolved = new URL(baseUrl).toString();
    resolvedHomeservers = { ...resolvedHomeservers, [homeserver]: resolved };
    return resolved;
  } catch (error) {
    console.warn('[sable auth] page homeserver discovery failed; using entered server', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return homeserver;
  }
}

export type CoreStatus = 'idle' | 'starting' | 'signed-out' | 'authenticating' | 'ready' | 'error';
export type CoreSession = SessionInfo;
export type ActiveVerification = { flowId: string; state: VerificationView };

export class CoreClient {
  status = $state<CoreStatus>('idle');
  session = $state<CoreSession | null>(null);
  accounts = $state<CoreSession[]>([]);
  verification = $state<ActiveVerification | null>(null);

  private transport: Transport | null = null;
  private unsubscribeTransport: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    const promise = this.startTransport();
    this.startPromise = promise;

    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  async login(homeserver: string, username: string, password: string): Promise<void> {
    let transport: Transport;
    try {
      transport = this.ensureTransport();
    } catch (error) {
      this.status = 'error';
      throw error;
    }

    const generation = ++this.generation;
    const previousSession = this.session;
    this.status = 'authenticating';

    try {
      const resolvedHomeserver = await resolveHomeserverInPage(homeserver);
      const response = await transport.send({
        type: 'login',
        homeserver: resolvedHomeserver,
        username,
        password,
      });

      if (generation !== this.generation || transport !== this.transport) return;

      await this.refreshAccounts();
      this.session = this.accounts.find((account) => account.user_id === response.user_id) ?? null;
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.session = previousSession;
        this.status = previousSession ? 'ready' : this.statusAfterAuthenticationError(error);
      }
      throw error;
    }
  }

  async loginFlows(homeserver: string): Promise<LoginFlowsView> {
    const transport = this.ensureTransport();
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver);
    const response = await transport.send({
      type: 'login_flows',
      homeserver: resolvedHomeserver,
    });
    return response.flows;
  }

  async registrationFlows(homeserver: string): Promise<RegistrationFlowsView> {
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver);
    const response = await this.ensureTransport().send({
      type: 'registration_flows',
      homeserver: resolvedHomeserver,
    });
    return response.flows;
  }

  async register(
    homeserver: string,
    username: string,
    password: string,
    registrationEmail: string | null = null,
    registrationToken: string | null = null
  ): Promise<RegistrationResultView> {
    let transport: Transport;
    try {
      transport = this.ensureTransport();
    } catch (error) {
      this.status = 'error';
      throw error;
    }

    const previousSession = this.session;
    this.status = 'authenticating';
    try {
      const resolvedHomeserver = await resolveHomeserverInPage(homeserver);
      const response = await transport.send({
        type: 'register',
        homeserver: resolvedHomeserver,
        username,
        password,
        registration_email: registrationEmail,
        registration_token: registrationToken,
      });
      const result = response.result;
      if (result.state === 'complete') {
        await this.refreshAccounts();
        this.session = this.accounts.find((account) => account.user_id === result.user_id) ?? null;
        this.status = 'ready';
      } else {
        this.session = previousSession;
        this.status = previousSession ? 'ready' : 'signed-out';
      }
      return result;
    } catch (error) {
      this.session = previousSession;
      this.status = previousSession ? 'ready' : this.statusAfterAuthenticationError(error);
      throw error;
    }
  }

  async continueRegistration(): Promise<RegistrationResultView> {
    const response = await this.ensureTransport().send({ type: 'continue_registration' });
    const result = response.result;
    if (result.state === 'complete') {
      await this.refreshAccounts();
      this.session = this.accounts.find((account) => account.user_id === result.user_id) ?? null;
      this.status = 'ready';
    }
    return result;
  }

  async requestRegistrationEmail(email: string): Promise<RegistrationResultView> {
    const response = await this.ensureTransport().send({
      type: 'request_registration_email',
      email,
    });
    return response.result;
  }

  async submitRegistrationEmail(token: string): Promise<RegistrationResultView> {
    const response = await this.ensureTransport().send({
      type: 'submit_registration_email',
      token,
    });
    return response.result;
  }

  async cancelRegistration(): Promise<void> {
    await this.ensureTransport().send({ type: 'cancel_registration' });
  }

  async startOidcLogin(
    homeserver: string,
    redirectUri: string,
    intent: AuthIntent = 'login'
  ): Promise<string> {
    const transport = this.ensureTransport();
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver);
    const response = await transport.send({
      type: 'start_oidc_login',
      homeserver: resolvedHomeserver,
      redirect_uri: redirectUri,
      intent,
    });
    return response.authorization_url;
  }

  async completeOidcLogin(callbackUrl: string): Promise<void> {
    let transport: Transport;
    try {
      transport = this.ensureTransport();
    } catch (error) {
      this.status = 'error';
      throw error;
    }

    const generation = ++this.generation;
    const previousSession = this.session;
    this.status = 'authenticating';

    try {
      const response = await transport.send({
        type: 'complete_oidc_login',
        callback_url: callbackUrl,
      });

      if (generation !== this.generation || transport !== this.transport) return;

      await this.refreshAccounts();
      this.session = this.accounts.find((account) => account.user_id === response.user_id) ?? null;
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.session = previousSession;
        this.status = previousSession ? 'ready' : this.statusAfterAuthenticationError(error);
      }
      throw error;
    }
  }

  async startSsoLogin(
    homeserver: string,
    redirectUri: string,
    idpId?: string,
    intent: AuthIntent = 'login'
  ): Promise<string> {
    const transport = this.ensureTransport();
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver);
    const response = await transport.send({
      type: 'start_sso_login',
      homeserver: resolvedHomeserver,
      redirect_uri: redirectUri,
      idp_id: idpId ?? null,
      intent,
    });
    return response.authorization_url;
  }

  async completeSsoLogin(callbackUrl: string): Promise<void> {
    let transport: Transport;
    try {
      transport = this.ensureTransport();
    } catch (error) {
      this.status = 'error';
      throw error;
    }

    const generation = ++this.generation;
    const previousSession = this.session;
    this.status = 'authenticating';

    try {
      const response = await transport.send({
        type: 'complete_sso_login',
        callback_url: callbackUrl,
      });

      if (generation !== this.generation || transport !== this.transport) return;

      await this.refreshAccounts();
      this.session = this.accounts.find((account) => account.user_id === response.user_id) ?? null;
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.session = previousSession;
        this.status = previousSession ? 'ready' : this.statusAfterAuthenticationError(error);
      }
      throw error;
    }
  }

  async subscribeRoomList(): Promise<{ subscription: SubscriptionId; rooms: RoomSummary[] }> {
    const response = await this.ensureTransport().send({ type: 'subscribe_room_list' });
    return response;
  }

  async subscribeTimeline(
    roomId: string,
    eventId: string | null = null
  ): Promise<{ subscription: SubscriptionId; items: TimelineItemView[] }> {
    const response = await this.ensureTransport().send({
      type: 'subscribe_timeline',
      room_id: roomId,
      event_id: eventId,
    });
    return response;
  }

  async paginate(
    subscription: SubscriptionId,
    direction: PaginationDirection,
    count: number
  ): Promise<{ reached_end: boolean }> {
    const response = await this.ensureTransport().send({
      type: 'paginate',
      subscription,
      direction,
      count,
    });
    return { reached_end: response.reached_end };
  }

  async roomMembers(roomId: string): Promise<MemberView[]> {
    const response = await this.ensureTransport().send({ type: 'room_members', room_id: roomId });
    return response.members;
  }

  async userProfile(userId: string): Promise<ProfileView> {
    const response = await this.ensureTransport().send({ type: 'user_profile', user_id: userId });
    return response.profile;
  }

  async sendMessage(roomId: string, body: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'send_message',
      room_id: roomId,
      body,
      formatted: null,
      in_reply_to: null,
    });
  }

  async sendAttachment(roomId: string, file: File): Promise<void> {
    if (file.size > maxAttachmentBytes) throw new Error('Attachment exceeds the 100 MiB limit');
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.ensureTransport().sendAttachment({
      roomId,
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      bytes,
    });
  }

  fetchMedia(source: string, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.ensureTransport().fetchMedia(source, width, height);
  }

  async markRead(roomId: string, eventId: string): Promise<void> {
    await this.ensureTransport().send({ type: 'mark_read', room_id: roomId, event_id: eventId });
  }

  async encryptionStatus(): Promise<EncryptionStatusView> {
    const response = await this.ensureTransport().send({ type: 'encryption_status' });
    return response.status;
  }

  async devices(): Promise<{ devices: DeviceView[]; accountManagement: boolean }> {
    const response = await this.ensureTransport().send({ type: 'devices' });
    return {
      devices: response.devices,
      accountManagement: response.account_management,
    };
  }

  async recoverIdentity(recoveryKey: string): Promise<void> {
    await this.ensureTransport().send({ type: 'recover_identity', recovery_key: recoveryKey });
  }

  async enableRecovery(): Promise<string> {
    const response = await this.ensureTransport().send({
      type: 'enable_recovery',
      passphrase: null,
    });
    return response.recovery_key;
  }

  async resetRecoveryKey(): Promise<string> {
    const response = await this.ensureTransport().send({
      type: 'reset_recovery_key',
      passphrase: null,
    });
    return response.recovery_key;
  }

  async switchAccount(accountId: string): Promise<void> {
    const response = await this.ensureTransport().send({
      type: 'switch_account',
      account_id: accountId,
    });
    this.session = response.session;
    await this.refreshAccounts();
    this.status = 'ready';
  }

  async logout(): Promise<void> {
    await this.ensureTransport().send({ type: 'logout' });
    this.generation += 1;
    this.session = null;
    this.accounts = [];
    this.verification = null;
    this.status = 'signed-out';
  }

  async renameDevice(deviceId: string, displayName: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'rename_device',
      device_id: deviceId,
      display_name: displayName,
    });
  }

  async deleteDevice(deviceId: string, password: string | null): Promise<string | null> {
    const response = await this.ensureTransport().send({
      type: 'delete_device',
      device_id: deviceId,
      password,
    });
    return response.management_url;
  }

  async requestVerification(userId: string): Promise<string> {
    const response = await this.ensureTransport().send({
      type: 'request_verification',
      user_id: userId,
    });
    this.verification = {
      flowId: response.flow_id,
      state: { phase: 'requested', is_self: true, initiated_by_us: true },
    };
    return response.flow_id;
  }

  async acceptVerification(userId: string, flowId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'accept_verification',
      user_id: userId,
      flow_id: flowId,
    });
  }

  async confirmVerification(userId: string, flowId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'confirm_verification',
      user_id: userId,
      flow_id: flowId,
    });
  }

  async cancelVerification(userId: string, flowId: string, mismatch = false): Promise<void> {
    await this.ensureTransport().send({
      type: 'cancel_verification',
      user_id: userId,
      flow_id: flowId,
      mismatch,
    });
  }

  async setTyping(roomId: string, typing: boolean): Promise<void> {
    await this.ensureTransport().send({ type: 'set_typing', room_id: roomId, typing });
  }

  async setDisplayName(name: string | null): Promise<void> {
    await this.ensureTransport().send({ type: 'set_display_name', name });
  }

  async setAvatarUrl(url: string | null): Promise<void> {
    await this.ensureTransport().send({ type: 'set_avatar_url', url });
  }

  async uploadAvatar(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const uri = await this.ensureTransport().uploadMedia(mime, bytes);
    await this.setAvatarUrl(uri);
    return uri;
  }

  async unsubscribe(subscription: SubscriptionId): Promise<void> {
    await this.ensureTransport().send({ type: 'unsubscribe', subscription });
  }

  subscribeEvents(onEvent: (event: CoreEvent) => void): () => void {
    return this.ensureTransport().subscribe((event) => {
      if (event.type === 'verification' && event.user_id === this.session?.user_id) {
        this.verification = { flowId: event.flow_id, state: event.state };
      }
      onEvent(event);
    });
  }

  stop(): void {
    this.generation += 1;
    this.startPromise = null;
    this.cleanupTransport();
    this.session = null;
    this.verification = null;
    this.status = 'idle';
  }

  private async startTransport(): Promise<void> {
    const generation = ++this.generation;
    this.status = 'starting';

    try {
      const transport = this.ensureTransport();
      const response = await transport.send({ type: 'restore' });
      if (generation !== this.generation) return;

      if (response.session) {
        this.session = response.session;
        await this.refreshAccounts();
        this.status = 'ready';
      } else {
        this.session = null;
        this.accounts = [];
        this.status = 'signed-out';
      }
    } catch {
      if (generation !== this.generation) return;

      this.session = null;
      this.status = 'error';
      this.cleanupTransport();
    }
  }

  private ensureTransport(): Transport {
    if (this.transport) return this.transport;

    const transport = createTransport();
    this.transport = transport;
    this.unsubscribeTransport = transport.subscribe(this.handleEvent);
    return transport;
  }

  private statusAfterAuthenticationError(error: unknown): CoreStatus {
    if (error instanceof CoreError) {
      switch (error.detail.code) {
        case 'denied':
        case 'rate_limited':
        case 'unsupported':
        case 'unknown_homeserver':
        case 'registration_unavailable':
        case 'username_taken':
        case 'invalid_username':
        case 'invalid_email':
        case 'email_verification_failed':
        case 'weak_password':
        case 'registration_stage_failed':
          return 'signed-out';
      }
    }
    return 'error';
  }

  private readonly handleEvent = (event: CoreEvent): void => {
    if (event.type !== 'session_ended') return;

    this.session = null;
    this.status = 'authenticating';
    void this.restoreFallbackAccount();
  };

  private async refreshAccounts(): Promise<void> {
    const response = await this.ensureTransport().send({ type: 'list_accounts' });
    this.accounts = response.accounts;
  }

  private async restoreFallbackAccount(): Promise<void> {
    try {
      await this.refreshAccounts();
      const fallbackAccountId = this.accounts.at(0)?.account_id;
      if (fallbackAccountId === undefined) {
        this.status = 'signed-out';
        return;
      }
      await this.switchAccount(fallbackAccountId);
    } catch {
      this.status = 'signed-out';
    }
  }

  private cleanupTransport(): void {
    const unsubscribe = this.unsubscribeTransport;
    const transport = this.transport;
    this.unsubscribeTransport = null;
    this.transport = null;

    try {
      unsubscribe?.();
    } catch {
      // Cleanup should continue even if a transport subscription fails.
    }

    try {
      transport?.close();
    } catch {
      // Closing an already-closed transport is safe to ignore.
    }
  }
}

export function createCoreClient(): CoreClient {
  return new CoreClient();
}
