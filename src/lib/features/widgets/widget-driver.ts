import {
  type Capability,
  type IOpenIDUpdate,
  type IRoomEvent,
  type ISearchUserDirectoryResult,
  type ISendEventDetails,
  OpenIDRequestState,
  type SimpleObservable,
  WidgetDriver,
} from 'matrix-widget-api';

import type { CoreClient } from '#lib/core/client.svelte.js';

export type CapabilityApproval = (requested: Set<Capability>) => Promise<Set<Capability>>;

const REDACTION_EVENT_TYPE = 'm.room.redaction';

export class SableWidgetDriver extends WidgetDriver {
  readonly #core: CoreClient;
  readonly #roomId: string;
  readonly #approve: CapabilityApproval;

  constructor(core: CoreClient, roomId: string, approve: CapabilityApproval) {
    super();
    this.#core = core;
    this.#roomId = roomId;
    this.#approve = approve;
  }

  override async validateCapabilities(requested: Set<Capability>): Promise<Set<Capability>> {
    return this.#approve(requested);
  }

  override async sendEvent(
    eventType: string,
    content: unknown,
    stateKey: string | null = null,
    roomId: string | null = null
  ): Promise<ISendEventDetails> {
    const target = roomId ?? this.#roomId;

    if (stateKey !== null) {
      await this.#core.commands.sendStateEvent(target, eventType, stateKey, content);
      return { roomId: target, eventId: '' };
    }

    if (eventType === REDACTION_EVENT_TYPE) {
      const redacts = (content as { redacts?: unknown }).redacts;
      if (typeof redacts !== 'string') throw new Error('redaction without a target');
      await this.#core.commands.redact(target, redacts, null);
      return { roomId: target, eventId: redacts };
    }

    await this.#core.commands.sendRawEvent(target, eventType, content);
    return { roomId: target, eventId: '' };
  }

  override async readRoomTimeline(
    roomId: string,
    eventType: string,
    msgtype: string | undefined,
    _stateKey: string | undefined,
    limit: number,
    since: string | undefined
  ): Promise<IRoomEvent[]> {
    const events = await this.#core.commands.roomTimelineEvents(
      roomId,
      eventType,
      msgtype ?? null,
      limit,
      since ?? null
    );
    return events as IRoomEvent[];
  }

  override async readRoomState(
    roomId: string,
    eventType: string,
    stateKey: string | undefined
  ): Promise<IRoomEvent[]> {
    const events = await this.#core.commands.roomStateEventsRaw(
      roomId,
      eventType,
      stateKey ?? null
    );
    return events as IRoomEvent[];
  }

  override async searchUserDirectory(
    searchTerm: string,
    limit?: number
  ): Promise<ISearchUserDirectoryResult> {
    const { limited, results } = await this.#core.commands.searchUserDirectory(
      searchTerm,
      limit ?? null
    );

    return {
      limited,
      results: results.map((user) => ({
        userId: user.user_id,
        displayName: user.display_name ?? undefined,
        avatarUrl: user.avatar_url ?? undefined,
      })),
    };
  }

  override askOpenID(observer: SimpleObservable<IOpenIDUpdate>): void {
    this.#core.commands
      .openIdToken()
      .then((token) => {
        observer.update({
          state: OpenIDRequestState.Allowed,
          token: {
            access_token: token.access_token,
            expires_in: Math.floor(token.expires_in_ms / 1000),
            matrix_server_name: token.matrix_server_name,
            token_type: token.token_type,
          },
        });
      })
      .catch((error: unknown) => {
        console.warn('[sable widgets] the OpenID grant failed', error);
        observer.update({ state: OpenIDRequestState.Blocked });
      });
  }

  override getKnownRooms(): string[] {
    return [this.#roomId];
  }
}
