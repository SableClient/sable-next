import type { CoreEvent } from '@/generated/CoreEvent';
import type { DeviceView } from '@/generated/DeviceView';
import type { EncryptionStatusView } from '@/generated/EncryptionStatusView';
import type { AuthIntent } from '@/generated/AuthIntent';
import type { LoginFlowsView } from '@/generated/LoginFlowsView';
import type { RegistrationFlowsView } from '@/generated/RegistrationFlowsView';
import type { ImagePackView } from '@/generated/ImagePackView';
import type { JoinRuleView } from '@/generated/JoinRuleView';
import type { MemberView } from '@/generated/MemberView';
import type { NotificationModeView } from '@/generated/NotificationModeView';
import type { NotificationSettingsView } from '@/generated/NotificationSettingsView';
import type { PusherView } from '@/generated/PusherView';
import type { RoomTag } from '@/generated/RoomTag';
import type { RoomPermissionsView } from '@/generated/RoomPermissionsView';
import type { RoomPreviewView } from '@/generated/RoomPreviewView';
import type { RoomSummary } from '@/generated/RoomSummary';
import type { SessionInfo } from '@/generated/SessionInfo';
import type { SpaceHierarchyRoomView } from '@/generated/SpaceHierarchyRoomView';
import type { SubscriptionId } from '@/generated/SubscriptionId';
import type { SyncStatus } from '@/generated/SyncStatus';
import type { PaginationDirection } from '@/generated/PaginationDirection';
import type { MutualRoomView } from '@/generated/MutualRoomView';
import type { ProfileView } from '@/generated/ProfileView';
import type { TimelineItemView } from '@/generated/TimelineItemView';
import type { RegistrationResultView } from '@/generated/RegistrationResultView';
import type { VerificationView } from '@/generated/VerificationView';

import { createTransport } from '../../transport/create';
import type { Transport } from '../../transport';
import { CoreError } from '../../transport';

type WellKnownResponse = { 'm.homeserver'?: { base_url?: unknown } };
const maxAttachmentBytes = 100 * 1024 * 1024;
const profileCacheFreshMs = 10 * 60 * 1000;
const relationsCacheFreshMs = 60 * 1000;

async function resolveHomeserverInPage(
  homeserver: string,
  cache: Map<string, string>
): Promise<string> {
  const cached = cache.get(homeserver);
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
    cache.set(homeserver, resolved);
    return resolved;
  } catch (error) {
    console.warn('[sable auth] page homeserver discovery failed; using entered server', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return homeserver;
  }
}

export type UserRelations = { mutualRooms: MutualRoomView[]; ignored: boolean };
export type CoreStatus = 'idle' | 'starting' | 'signed-out' | 'authenticating' | 'ready' | 'error';
export type CoreSession = SessionInfo;
export type ActiveVerification = { flowId: string; state: VerificationView };
export type CreateRoomOptions = {
  name?: string | null;
  topic?: string | null;
  isSpace?: boolean;
  /** Published in the directory, joinable by link. */
  public?: boolean;
  /** Ignored for a space or a public room. */
  encrypted?: boolean;
  invite?: string[];
  /** Adds an `m.space.child` edge from this space. */
  parentSpace?: string | null;
};

export class CoreClient {
  status = $state<CoreStatus>('idle');
  session = $state<CoreSession | null>(null);
  accounts = $state<CoreSession[]>([]);
  verification = $state<ActiveVerification | null>(null);
  crashed = $state<string | null>(null);
  sync = $state<SyncStatus | null>(null);
  unresponsive = $state(false);

  private transport: Transport | null = null;
  private unsubscribeTransport: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  /* Nothing renders from these, and a reactive map would make every mounted
     profile card re-run its effect on any other user's cache write. */
  /* eslint-disable svelte/prefer-svelte-reactivity */
  private readonly profileCache = new Map<
    string,
    { accountId: string | null; fetchedAt: number; profile: ProfileView }
  >();
  private readonly profileRequests = new Map<
    string,
    { accountId: string | null; request: Promise<ProfileView> }
  >();
  private readonly relationsCache = new Map<
    string,
    { accountId: string | null; fetchedAt: number; relations: UserRelations }
  >();
  private readonly resolvedHomeservers = new Map<string, string>();
  /* eslint-enable svelte/prefer-svelte-reactivity */

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
      const resolvedHomeserver = await resolveHomeserverInPage(
        homeserver,
        this.resolvedHomeservers
      );
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
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver, this.resolvedHomeservers);
    const response = await transport.send({
      type: 'login_flows',
      homeserver: resolvedHomeserver,
    });
    return response.flows;
  }

  async registrationFlows(homeserver: string): Promise<RegistrationFlowsView> {
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver, this.resolvedHomeservers);
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
      const resolvedHomeserver = await resolveHomeserverInPage(
        homeserver,
        this.resolvedHomeservers
      );
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
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver, this.resolvedHomeservers);
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
    const resolvedHomeserver = await resolveHomeserverInPage(homeserver, this.resolvedHomeservers);
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
    eventId: string | null = null,
    hiddenEvents = false
  ): Promise<{ subscription: SubscriptionId; items: TimelineItemView[] }> {
    const response = await this.ensureTransport().send({
      type: 'subscribe_timeline',
      room_id: roomId,
      event_id: eventId,
      hidden_events: hiddenEvents,
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

  async roomPermissions(roomId: string): Promise<RoomPermissionsView> {
    const response = await this.ensureTransport().send({
      type: 'room_permissions',
      room_id: roomId,
    });
    return response;
  }

  async imagePacks(roomId: string): Promise<ImagePackView[]> {
    const response = await this.ensureTransport().send({ type: 'image_packs', room_id: roomId });
    return response.packs;
  }

  async userProfile(userId: string): Promise<ProfileView> {
    const accountId = this.session?.account_id ?? null;
    const cached = this.profileCache.get(userId);
    if (cached?.accountId === accountId && Date.now() - cached.fetchedAt < profileCacheFreshMs) {
      return cached.profile;
    }

    const pending = this.profileRequests.get(userId);
    if (pending?.accountId === accountId) return pending.request;

    const request = this.ensureTransport()
      .send({ type: 'user_profile', user_id: userId })
      .then((response) => {
        this.profileCache.set(userId, {
          accountId,
          fetchedAt: Date.now(),
          profile: response.profile,
        });
        return response.profile;
      });
    this.profileRequests.set(userId, { accountId, request });
    const clearRequest = () => {
      if (this.profileRequests.get(userId)?.request === request) {
        this.profileRequests.delete(userId);
      }
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }

  /**
   * Rooms shared with this user, plus whether the account ignores them. Cached
   * because the core reads membership once per joined room to answer it.
   */
  async userRelations(userId: string): Promise<UserRelations> {
    const accountId = this.session?.account_id ?? null;
    const cached = this.relationsCache.get(userId);
    if (cached?.accountId === accountId && Date.now() - cached.fetchedAt < relationsCacheFreshMs) {
      return cached.relations;
    }

    const response = await this.ensureTransport().send({
      type: 'user_relations',
      user_id: userId,
    });
    const relations = { mutualRooms: response.mutual_rooms, ignored: response.ignored };
    this.relationsCache.set(userId, { accountId, fetchedAt: Date.now(), relations });
    return relations;
  }

  async setUserIgnored(userId: string, ignored: boolean): Promise<void> {
    await this.ensureTransport().send(
      ignored
        ? { type: 'ignore_user', user_id: userId }
        : { type: 'unignore_user', user_id: userId }
    );
    this.relationsCache.delete(userId);
  }

  async inviteUser(roomId: string, userId: string): Promise<void> {
    await this.ensureTransport().send({ type: 'invite_user', room_id: roomId, user_id: userId });
  }

  async kickUser(roomId: string, userId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'kick_user',
      room_id: roomId,
      user_id: userId,
      reason: null,
    });
  }

  async banUser(roomId: string, userId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'ban_user',
      room_id: roomId,
      user_id: userId,
      reason: null,
    });
  }

  async unbanUser(roomId: string, userId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'unban_user',
      room_id: roomId,
      user_id: userId,
      reason: null,
    });
  }

  async createRoom(options: CreateRoomOptions): Promise<string> {
    const response = await this.ensureTransport().send({
      type: 'create_room',
      name: options.name ?? null,
      topic: options.topic ?? null,
      is_space: options.isSpace ?? false,
      public: options.public ?? false,
      encrypted: options.encrypted ?? true,
      invite: options.invite ?? [],
      parent_space: options.parentSpace ?? null,
    });
    return response.room_id;
  }

  /** Always creates a room; it does not look for an existing DM with this user. */
  async createDm(userId: string): Promise<string> {
    const response = await this.ensureTransport().send({ type: 'create_dm', user_id: userId });
    return response.room_id;
  }

  /** Works for a room this account has not joined. */
  async roomPreview(address: string, via: string[] = []): Promise<RoomPreviewView> {
    const response = await this.ensureTransport().send({ type: 'room_preview', address, via });
    return response.preview;
  }

  /** `address` is a room id or an alias. Returns the resolved id. */
  async joinRoom(address: string, via: string[] = []): Promise<string> {
    const response = await this.ensureTransport().send({ type: 'join_room', address, via });
    return response.room_id;
  }

  /** The only way into a `knock` room; `joinRoom` is refused on one. */
  async knockRoom(address: string, via: string[] = [], reason?: string): Promise<string> {
    const response = await this.ensureTransport().send({
      type: 'knock_room',
      address,
      via,
      reason: reason ?? null,
    });
    return response.room_id;
  }

  /** Empty for a room with a canonical alias, which routes on its own. */
  async roomViaServers(roomId: string): Promise<string[]> {
    const response = await this.ensureTransport().send({
      type: 'room_via_servers',
      room_id: roomId,
    });
    return response.servers;
  }

  /** Also how an invitation is declined. */
  async leaveRoom(roomId: string): Promise<void> {
    await this.ensureTransport().send({ type: 'leave_room', room_id: roomId });
  }

  async addToSpace(spaceId: string, roomId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'add_to_space',
      space_id: spaceId,
      room_id: roomId,
    });
  }

  /**
   * The server's own view, so it includes rooms this account has not joined. The
   * root space is in `rooms`; walk its `children` to rebuild the tree.
   */
  async spaceHierarchy(
    spaceId: string,
    from: string | null = null
  ): Promise<{ rooms: SpaceHierarchyRoomView[]; nextBatch: string | null }> {
    const response = await this.ensureTransport().send({
      type: 'space_hierarchy',
      space_id: spaceId,
      from,
    });
    return { rooms: response.rooms, nextBatch: response.next_batch };
  }

  async removeFromSpace(spaceId: string, roomId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'remove_from_space',
      space_id: spaceId,
      room_id: roomId,
    });
  }

  async sendMessage(
    roomId: string,
    body: string,
    inReplyTo: string | null = null,
    formatted: string | null = null
  ): Promise<void> {
    await this.ensureTransport().send({
      type: 'send_message',
      room_id: roomId,
      body,
      formatted,
      in_reply_to: inReplyTo,
    });
  }

  async sendSticker(roomId: string, url: string, body: string): Promise<void> {
    await this.ensureTransport().send({ type: 'send_sticker', room_id: roomId, url, body });
  }

  async editMessage(
    roomId: string,
    eventId: string,
    body: string,
    formatted: string | null = null
  ): Promise<void> {
    await this.ensureTransport().send({
      type: 'edit_message',
      room_id: roomId,
      event_id: eventId,
      body,
      formatted,
    });
  }

  /** The filled-in details arrive on the timeline diff stream, not here. */
  async fetchEventDetails(roomId: string, eventId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'fetch_event_details',
      room_id: roomId,
      event_id: eventId,
    });
  }

  async redact(roomId: string, eventId: string, reason: string | null = null): Promise<void> {
    await this.ensureTransport().send({
      type: 'redact',
      room_id: roomId,
      event_id: eventId,
      reason,
    });
  }

  /** The core toggles, so sending the same key twice redacts the reaction. */
  async toggleReaction(roomId: string, eventId: string, key: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'react',
      room_id: roomId,
      event_id: eventId,
      key,
    });
  }

  async retrySend(roomId: string, transactionId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'retry_send',
      room_id: roomId,
      transaction_id: transactionId,
    });
  }

  async cancelSend(roomId: string, transactionId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'cancel_send',
      room_id: roomId,
      transaction_id: transactionId,
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

  async notificationSettings(roomId: string): Promise<NotificationSettingsView> {
    const response = await this.ensureTransport().send({
      type: 'notification_settings',
      room_id: roomId,
    });
    return response;
  }

  /** `null` drops the room's own rule so it follows the account default. */
  async setRoomNotificationMode(roomId: string, mode: NotificationModeView | null): Promise<void> {
    await this.ensureTransport().send({
      type: 'set_room_notification_mode',
      room_id: roomId,
      mode,
    });
  }

  async defaultNotificationModes(): Promise<{
    direct: NotificationModeView;
    group: NotificationModeView;
  }> {
    const response = await this.ensureTransport().send({ type: 'default_notification_modes' });
    return { direct: response.direct, group: response.group };
  }

  async setDefaultNotificationMode(direct: boolean, mode: NotificationModeView): Promise<void> {
    await this.ensureTransport().send({
      type: 'set_default_notification_mode',
      direct,
      mode,
    });
  }

  async setPusher(pusher: PusherView): Promise<void> {
    await this.ensureTransport().send({ type: 'set_pusher', pusher });
  }

  async removePusher(pushkey: string, appId: string): Promise<void> {
    await this.ensureTransport().send({ type: 'remove_pusher', pushkey, app_id: appId });
  }

  async setNotificationContent(visible: boolean): Promise<void> {
    await this.ensureTransport().send({ type: 'set_notification_content', visible });
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
    this.resetCachedState();
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

  /** `m.direct` is client-owned; nothing else will correct it. */
  async setDirect(roomId: string, direct: boolean): Promise<void> {
    await this.ensureTransport().send({ type: 'set_direct', room_id: roomId, direct });
  }

  async setRoomTag(roomId: string, tag: RoomTag, set: boolean): Promise<void> {
    await this.ensureTransport().send({ type: 'set_room_tag', room_id: roomId, tag, set });
  }

  async setRoomName(roomId: string, name: string | null): Promise<void> {
    await this.ensureTransport().send({ type: 'set_room_name', room_id: roomId, name });
  }

  async setRoomTopic(roomId: string, topic: string): Promise<void> {
    await this.ensureTransport().send({ type: 'set_room_topic', room_id: roomId, topic });
  }

  async setRoomAvatar(roomId: string, url: string | null): Promise<void> {
    await this.ensureTransport().send({ type: 'set_room_avatar', room_id: roomId, url });
  }

  async uploadRoomAvatar(
    roomId: string,
    mime: string,
    bytes: Uint8Array<ArrayBuffer>
  ): Promise<string> {
    const uri = await this.ensureTransport().uploadMedia(mime, bytes);
    await this.setRoomAvatar(roomId, uri);
    return uri;
  }

  async setRoomJoinRule(roomId: string, rule: JoinRuleView): Promise<void> {
    await this.ensureTransport().send({ type: 'set_room_join_rule', room_id: roomId, rule });
  }

  /** Escape hatch for unmodelled state; prefer a typed method where one exists. */
  async sendStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: unknown
  ): Promise<void> {
    await this.ensureTransport().send({
      type: 'send_state_event',
      room_id: roomId,
      event_type: eventType,
      state_key: stateKey,
      content,
    });
  }

  /** Lowering your own cannot be undone: the level to raise it back is gone. */
  async setUserPowerLevel(roomId: string, userId: string, powerLevel: number): Promise<void> {
    await this.ensureTransport().send({
      type: 'set_user_power_level',
      room_id: roomId,
      user_id: userId,
      power_level: powerLevel,
    });
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
    this.resetCachedState();
    this.status = 'idle';
  }

  private resetCachedState(): void {
    this.profileCache.clear();
    this.profileRequests.clear();
    this.relationsCache.clear();
    this.sync = null;
    this.crashed = null;
    this.unresponsive = false;
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
    const unsubscribeEvents = transport.subscribe(this.handleEvent);
    const unsubscribeCrash = transport.subscribeCrash((message) => {
      this.crashed = message;
    });
    const unsubscribeStall = transport.subscribeStall((stalled) => {
      this.unresponsive = stalled;
    });
    this.unsubscribeTransport = () => {
      unsubscribeEvents();
      unsubscribeCrash();
      unsubscribeStall();
    };
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
    if (event.type === 'sync_status') {
      this.sync = event;
      return;
    }
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
