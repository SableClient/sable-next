import type { CoreEvent } from '#src/generated/CoreEvent';
import type { DeviceView } from '#src/generated/DeviceView';
import type { EncryptionStatusView } from '#src/generated/EncryptionStatusView';
import type { SearchCoverageView } from '#src/generated/SearchCoverageView';
import type { AuthIntent } from '#src/generated/AuthIntent';
import type { LoginFlowsView } from '#src/generated/LoginFlowsView';
import type { RegistrationFlowsView } from '#src/generated/RegistrationFlowsView';
import type { SessionInfo } from '#src/generated/SessionInfo';
import type { SyncStatus } from '#src/generated/SyncStatus';
import type { MutualRoomView } from '#src/generated/MutualRoomView';
import type { ProfileView } from '#src/generated/ProfileView';
import type { RegistrationResultView } from '#src/generated/RegistrationResultView';
import type { VerificationView } from '#src/generated/VerificationView';

import { createCommands } from './commands.svelte.js';
import { createTransport } from '../../transport/create';
import type { Transport } from '../../transport';
import { CoreError } from '../../transport';
import { on } from 'svelte/events';
import { onDebugLogCapture, recordDebugLog } from '#lib/observability/debug-log.svelte.js';

type WellKnownResponse = { 'm.homeserver'?: { base_url?: unknown } };
export type { CallGrant, CreateRoomOptions, OutgoingMentions } from './commands.svelte.js';

const profileCacheFreshMs = 10 * 60 * 1000;
const relationsCacheFreshMs = 60 * 1000;
const MAX_PROFILE_CACHE_ENTRIES = 256;
const MAX_RELATIONS_CACHE_ENTRIES = 128;

async function discoverBaseUrl(origin: URL): Promise<string | null> {
  try {
    const response = await fetch(new URL('/.well-known/matrix/client', origin), { mode: 'cors' });
    if (!response.ok) return null;
    const body = (await response.json()) as WellKnownResponse;
    const baseUrl = body['m.homeserver']?.base_url;
    if (typeof baseUrl !== 'string') return null;
    return new URL(baseUrl).toString();
  } catch (error) {
    console.warn('[sable auth] page homeserver discovery failed; using entered server', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

async function grantLocalNetworkAccess(baseUrl: string): Promise<void> {
  try {
    await fetch(new URL('_matrix/client/versions', baseUrl), { mode: 'cors' });
  } catch (error) {
    console.warn('[sable auth] homeserver unreachable from the page', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

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

  const resolved = await discoverBaseUrl(origin);
  await grantLocalNetworkAccess(resolved ?? origin.toString());
  if (resolved === null) return homeserver;

  cache.set(homeserver, resolved);
  return resolved;
}

export type UserRelations = { mutualRooms: MutualRoomView[]; ignored: boolean };
export type CoreStatus = 'idle' | 'starting' | 'signed-out' | 'authenticating' | 'ready' | 'error';
export type CoreSession = SessionInfo;
export type ActiveVerification = { flowId: string; state: VerificationView };

export class CoreClient {
  status = $state<CoreStatus>('idle');
  session = $state<CoreSession | null>(null);
  accounts = $state.raw<CoreSession[]>([]);
  verification = $state<ActiveVerification | null>(null);
  crashed = $state<string | null>(null);
  sync = $state<SyncStatus | null>(null);
  /** This device's own verification and recovery state, pushed on change. */
  encryption = $state<EncryptionStatusView | null>(null);
  searchCoverage = $state<SearchCoverageView | null>(null);
  searchCoverageUnavailable = $state(false);
  /** Every device on this account, pushed on change. Absolute, not a diff. */
  deviceList = $state.raw<DeviceView[]>([]);
  unresponsive = $state(false);
  accountRevision = $state(0);

  private transport: Transport | null = null;
  private unsubscribeTransport: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private readonly accountChannel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sable-active-account');
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

  private stopAccountChannel: (() => void) | null = null;

  readonly commands = createCommands(() => this.ensureTransport());

  constructor(private readonly openTransport: () => Transport = createTransport) {
    if (this.accountChannel) {
      this.stopAccountChannel = on(this.accountChannel, 'message', () => {
        void this.syncAccountFromWorker();
      });
    }
  }

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
      this.replaceSession(
        this.accounts.find((account) => account.user_id === response.user_id) ?? null
      );
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.replaceSession(previousSession);
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
        this.replaceSession(
          this.accounts.find((account) => account.user_id === result.user_id) ?? null
        );
        this.status = 'ready';
      } else {
        this.replaceSession(previousSession);
        this.status = previousSession ? 'ready' : 'signed-out';
      }
      return result;
    } catch (error) {
      this.replaceSession(previousSession);
      this.status = previousSession ? 'ready' : this.statusAfterAuthenticationError(error);
      throw error;
    }
  }

  async continueRegistration(): Promise<RegistrationResultView> {
    const response = await this.ensureTransport().send({
      type: 'continue_registration',
    });
    const result = response.result;
    if (result.state === 'complete') {
      await this.refreshAccounts();
      this.replaceSession(
        this.accounts.find((account) => account.user_id === result.user_id) ?? null
      );
      this.status = 'ready';
    }
    return result;
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
      this.replaceSession(
        this.accounts.find((account) => account.user_id === response.user_id) ?? null
      );
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.replaceSession(previousSession);
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
      this.replaceSession(
        this.accounts.find((account) => account.user_id === response.user_id) ?? null
      );
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.replaceSession(previousSession);
        this.status = previousSession ? 'ready' : this.statusAfterAuthenticationError(error);
      }
      throw error;
    }
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
        if (this.profileCache.size > MAX_PROFILE_CACHE_ENTRIES) {
          const oldest = this.profileCache.keys().next().value;
          if (oldest !== undefined) this.profileCache.delete(oldest);
        }
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
    const relations = {
      mutualRooms: response.mutual_rooms,
      ignored: response.ignored,
    };
    this.relationsCache.set(userId, {
      accountId,
      fetchedAt: Date.now(),
      relations,
    });
    if (this.relationsCache.size > MAX_RELATIONS_CACHE_ENTRIES) {
      const oldest = this.relationsCache.keys().next().value;
      if (oldest !== undefined) this.relationsCache.delete(oldest);
    }
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

  async refreshSearchCoverage(attempts = 3): Promise<void> {
    const generation = this.generation;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.ensureTransport().send({
          type: 'search_coverage',
        });
        if (generation !== this.generation) return;
        this.searchCoverage = response.coverage;
        this.searchCoverageUnavailable = false;
        return;
      } catch (error) {
        if (generation !== this.generation) return;
        console.warn('[sable core] search coverage unavailable', error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (generation === this.generation) this.searchCoverageUnavailable = true;
  }

  async switchAccount(accountId: string): Promise<void> {
    const response = await this.ensureTransport().send({
      type: 'switch_account',
      account_id: accountId,
    });
    this.replaceSession(response.session);
    await this.refreshAccounts();
    this.status = 'ready';
  }

  async removeAccount(accountId: string): Promise<void> {
    await this.ensureTransport().send({
      type: 'remove_account',
      account_id: accountId,
    });
    await this.refreshAccounts();
  }

  async logout(): Promise<void> {
    await this.ensureTransport().send({ type: 'logout' });
    this.generation += 1;
    this.replaceSession(null);
    this.accounts = [];
    this.verification = null;
    this.status = 'signed-out';
  }

  async resetCaches(): Promise<void> {
    await this.ensureTransport().resetCaches();
  }

  async requestVerification(userId: string, deviceId: string | null = null): Promise<string> {
    const response = await this.ensureTransport().send({
      type: 'request_verification',
      user_id: userId,
      device_id: deviceId,
    });
    this.verification = {
      flowId: response.flow_id,
      state: { phase: 'requested', is_self: true, initiated_by_us: true },
    };
    return response.flow_id;
  }

  async setProfileField(field: string, value: unknown): Promise<void> {
    await this.ensureTransport().send({
      type: 'set_profile_field',
      field,
      value,
    });
    this.profileCache.delete(this.session?.user_id ?? '');
  }

  async uploadRoomAvatar(
    roomId: string,
    mime: string,
    bytes: Uint8Array<ArrayBuffer>
  ): Promise<string> {
    const uri = await this.ensureTransport().uploadMedia(mime, bytes);
    await this.commands.setRoomAvatar(roomId, uri);
    return uri;
  }

  async uploadAvatar(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const uri = await this.ensureTransport().uploadMedia(mime, bytes);
    await this.commands.setAvatarUrl(uri);
    return uri;
  }

  subscribeEvents(onEvent: (event: CoreEvent) => void): () => void {
    return this.ensureTransport().subscribe((event) => {
      if (event.type === 'verification' && event.user_id === this.session?.user_id) {
        const isTerminal = event.state.phase === 'done' || event.state.phase === 'cancelled';
        if (!isTerminal || this.verification?.flowId === event.flow_id) {
          this.verification = { flowId: event.flow_id, state: event.state };
        }
      }
      onEvent(event);
    });
  }

  stop(): void {
    this.generation += 1;
    this.startPromise = null;
    this.cleanupTransport();
    this.replaceSession(null, false);
    this.verification = null;
    this.resetCachedState();
    this.status = 'idle';
    this.stopAccountChannel?.();
    this.stopAccountChannel = null;
    this.accountChannel?.close();
  }

  private resetCachedState(): void {
    this.profileCache.clear();
    this.profileRequests.clear();
    this.relationsCache.clear();
    this.sync = null;
    this.crashed = null;
    this.unresponsive = false;
    this.encryption = null;
    this.deviceList = [];
    this.searchCoverage = null;
    this.searchCoverageUnavailable = false;
  }

  /** Both events fire only on a change, so a session that starts unverified
      would otherwise report nothing. */
  private async primeEncryptionStatus(): Promise<void> {
    const generation = this.generation;
    try {
      const [status, devices] = await Promise.all([
        this.commands.encryptionStatus(),
        this.commands.devices(),
      ]);
      if (generation !== this.generation) return;
      this.encryption = status;
      this.deviceList = devices.devices;
    } catch (error) {
      console.debug('[sable core] encryption status unavailable', error);
    }
  }

  private replaceSession(session: CoreSession | null, broadcast = true): void {
    const changed = this.session?.account_id !== session?.account_id;
    if (changed) {
      this.accountRevision += 1;
      this.resetCachedState();
    }
    this.session = session;
    if (changed && session) {
      void this.primeEncryptionStatus();
      void this.primeSyncStatus();
    }
    if (changed && broadcast) this.accountChannel?.postMessage(null);
  }

  private async syncAccountFromWorker(): Promise<void> {
    try {
      const response = await this.ensureTransport().send({ type: 'restore' });
      if (response.session) {
        this.replaceSession(response.session);
        await this.refreshAccounts();
        this.status = 'ready';
      } else {
        this.replaceSession(null);
        this.accounts = [];
        this.status = 'signed-out';
      }
    } catch {
      // The worker may have closed before this tab receives the broadcast.
    }
  }

  private async startTransport(): Promise<void> {
    const generation = ++this.generation;
    this.status = 'starting';

    try {
      const transport = this.ensureTransport();
      const response = await transport.send({ type: 'restore' });
      if (generation !== this.generation) return;

      if (response.session) {
        this.replaceSession(response.session);
        await this.refreshAccounts();
        this.status = 'ready';
      } else {
        this.replaceSession(null);
        this.accounts = [];
        this.status = 'signed-out';
      }
    } catch {
      if (generation !== this.generation) return;

      this.replaceSession(null);
      this.status = 'signed-out';
      this.cleanupTransport();
    }
  }

  private ensureTransport(): Transport {
    if (this.transport) return this.transport;

    const transport = this.openTransport();
    this.transport = transport;
    const unsubscribeEvents = transport.subscribe(this.handleEvent);
    const unsubscribeCrash = transport.subscribeCrash((message) => {
      this.crashed = message;
      this.accountRevision += 1;
      this.cleanupTransport();
      this.status = 'error';
    });
    const unsubscribeStall = transport.subscribeStall((stalled) => {
      this.unresponsive = stalled;
    });
    const stopLogCapture = onDebugLogCapture((enabled) => {
      transport.setDebugLogs(enabled);
    });
    this.unsubscribeTransport = () => {
      unsubscribeEvents();
      unsubscribeCrash();
      unsubscribeStall();
      stopLogCapture();
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

  private async primeSyncStatus(): Promise<void> {
    const generation = this.generation;
    try {
      const status = await this.commands.syncStatus();
      if (generation !== this.generation || this.sync !== null) return;
      this.sync = status;
    } catch (error) {
      console.debug('[sable core] sync status unavailable', error);
    }
  }

  private readonly handleEvent = (event: CoreEvent): void => {
    recordDebugLog('debug', event.type === 'sync_status' ? 'sync' : 'general', 'core', event.type);
    switch (event.type) {
      case 'sync_status':
        this.sync = event;
        return;
      case 'encryption_status':
        this.encryption = event.status;
        return;
      case 'devices_changed':
        this.deviceList = event.devices;
        return;
      case 'search_coverage':
        this.searchCoverage = event.coverage;
        this.searchCoverageUnavailable = false;
        return;
      case 'session_ended':
        this.replaceSession(null);
        this.status = 'authenticating';
        void this.restoreFallbackAccount();
        return;
      default:
        return;
    }
  };

  private async refreshAccounts(): Promise<void> {
    const response = await this.ensureTransport().send({
      type: 'list_accounts',
    });
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

export function createCoreClient(openTransport?: () => Transport): CoreClient {
  return new CoreClient(openTransport);
}
