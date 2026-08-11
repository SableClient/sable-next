import type { CoreEvent } from '@/generated/CoreEvent';
import type { LoginFlowsView } from '@/generated/LoginFlowsView';
import type { MemberView } from '@/generated/MemberView';
import type { RoomSummary } from '@/generated/RoomSummary';
import type { SessionInfo } from '@/generated/SessionInfo';
import type { SubscriptionId } from '@/generated/SubscriptionId';
import type { TimelineItemView } from '@/generated/TimelineItemView';

import { createTransport } from '../../transport/create';
import type { Transport } from '../../transport';
import { CoreError } from '../../transport';

export type CoreStatus = 'idle' | 'starting' | 'signed-out' | 'authenticating' | 'ready' | 'error';
export type CoreSession = Pick<SessionInfo, 'user_id'> & Partial<Pick<SessionInfo, 'device_id'>>;

export class CoreClient {
  status = $state<CoreStatus>('idle');
  session = $state<CoreSession | null>(null);

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
    this.status = 'authenticating';
    this.session = null;

    try {
      const response = await transport.send({
        type: 'login',
        homeserver,
        username,
        password,
      });

      if (generation !== this.generation || transport !== this.transport) return;

      this.session = { user_id: response.user_id };
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.status = this.statusAfterAuthenticationError(error);
      }
      throw error;
    }
  }

  async loginFlows(homeserver: string): Promise<LoginFlowsView> {
    const transport = this.ensureTransport();
    const response = await transport.send({
      type: 'login_flows',
      homeserver,
    });
    return response.flows;
  }

  async startOidcLogin(homeserver: string, redirectUri: string): Promise<string> {
    const transport = this.ensureTransport();
    const response = await transport.send({
      type: 'start_oidc_login',
      homeserver,
      redirect_uri: redirectUri,
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
    this.status = 'authenticating';
    this.session = null;

    try {
      const response = await transport.send({
        type: 'complete_oidc_login',
        callback_url: callbackUrl,
      });

      if (generation !== this.generation || transport !== this.transport) return;

      this.session = { user_id: response.user_id };
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.status = this.statusAfterAuthenticationError(error);
      }
      throw error;
    }
  }

  async startSsoLogin(homeserver: string, redirectUri: string, idpId?: string): Promise<string> {
    const transport = this.ensureTransport();
    const response = await transport.send({
      type: 'start_sso_login',
      homeserver,
      redirect_uri: redirectUri,
      idp_id: idpId ?? null,
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
    this.status = 'authenticating';
    this.session = null;

    try {
      const response = await transport.send({
        type: 'complete_sso_login',
        callback_url: callbackUrl,
      });

      if (generation !== this.generation || transport !== this.transport) return;

      this.session = { user_id: response.user_id };
      this.status = 'ready';
    } catch (error) {
      if (generation === this.generation && transport === this.transport) {
        this.status = this.statusAfterAuthenticationError(error);
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

  async paginate(subscription: SubscriptionId, count: number): Promise<{ reached_start: boolean }> {
    const response = await this.ensureTransport().send({
      type: 'paginate',
      subscription,
      count,
    });
    return response;
  }

  async roomMembers(roomId: string): Promise<MemberView[]> {
    const response = await this.ensureTransport().send({ type: 'room_members', room_id: roomId });
    return response.members;
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

  async markRead(roomId: string, eventId: string): Promise<void> {
    await this.ensureTransport().send({ type: 'mark_read', room_id: roomId, event_id: eventId });
  }

  async setTyping(roomId: string, typing: boolean): Promise<void> {
    await this.ensureTransport().send({ type: 'set_typing', room_id: roomId, typing });
  }

  async unsubscribe(subscription: SubscriptionId): Promise<void> {
    await this.ensureTransport().send({ type: 'unsubscribe', subscription });
  }

  subscribeEvents(onEvent: (event: CoreEvent) => void): () => void {
    return this.ensureTransport().subscribe(onEvent);
  }

  stop(): void {
    this.generation += 1;
    this.startPromise = null;
    this.cleanupTransport();
    this.session = null;
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
        this.status = 'ready';
      } else {
        this.session = null;
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
          return 'signed-out';
      }
    }
    return 'error';
  }

  private readonly handleEvent = (event: CoreEvent): void => {
    if (event.type !== 'session_ended') return;

    this.session = null;
    this.status = 'signed-out';
  };

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
