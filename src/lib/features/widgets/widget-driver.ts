import {
  type Capability,
  type IGetMediaConfigResult,
  type IOpenIDUpdate,
  type IReadEventRelationsResult,
  type IRoomAccountData,
  type IRoomEvent,
  type IRtcLivekitDelegateDelayedLeaveFromWidgetRequestData,
  type IRtcLivekitDelegateDelayedLeaveFromWidgetResponseData,
  type IRtcLivekitGetTokenFromWidgetRequestData,
  type IRtcLivekitGetTokenFromWidgetResponseData,
  type IRtcTransportsResult,
  type ISearchUserDirectoryResult,
  type ISendDelayedEventDetails,
  type ISendEventDetails,
  type ITurnServer,
  type IWidgetApiErrorResponseDataDetails,
  OpenIDRequestState,
  type SimpleObservable,
  Symbols,
  WidgetDriver,
} from 'matrix-widget-api';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { CoreError } from '#src/transport';

export type CapabilityApproval = (requested: Set<Capability>) => Promise<Set<Capability>>;

const REDACTION_EVENT_TYPE = 'm.room.redaction';
const MATRIX_TO_PREFIX = 'https://matrix.to/#/';
const TURN_REFRESH_FRACTION = 0.9;
const TURN_MIN_REFRESH_MS = 30_000;

const MATRIX_ERRORS: Partial<Record<string, { status: number; errcode: string }>> = {
  unsupported: { status: 404, errcode: 'M_UNRECOGNIZED' },
  delayed_events_unsupported: { status: 404, errcode: 'M_UNRECOGNIZED' },
  unknown_room: { status: 404, errcode: 'M_NOT_FOUND' },
  denied: { status: 403, errcode: 'M_FORBIDDEN' },
  encrypted_schedule_unsupported: { status: 403, errcode: 'M_FORBIDDEN' },
  rate_limited: { status: 429, errcode: 'M_LIMIT_EXCEEDED' },
};

async function uploadBytes(
  file: XMLHttpRequestBodyInit
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  if (file instanceof Blob) {
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type || 'application/octet-stream',
    };
  }
  if (file instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(file.slice(0)), mime: 'application/octet-stream' };
  }
  if (ArrayBuffer.isView(file)) {
    const bytes = new Uint8Array(file.byteLength);
    bytes.set(new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
    return { bytes, mime: 'application/octet-stream' };
  }
  throw new Error('unsupported upload body');
}

export class SableWidgetDriver extends WidgetDriver {
  readonly #core: CoreClient;
  readonly #roomId: string;
  readonly #approve: CapabilityApproval;
  readonly #navigate: (permalink: string) => Promise<void>;
  readonly #knownRooms: Set<string>;

  constructor(
    core: CoreClient,
    roomId: string,
    approve: CapabilityApproval,
    navigate: (permalink: string) => Promise<void>
  ) {
    super();
    this.#core = core;
    this.#roomId = roomId;
    this.#approve = approve;
    this.#navigate = navigate;
    this.#knownRooms = new Set([roomId]);
  }

  noteRooms(roomIds: readonly string[]): void {
    for (const roomId of roomIds) this.#knownRooms.add(roomId);
  }

  #resolveRooms(roomIds: readonly string[] | null | undefined): string[] {
    if (!roomIds) return [this.#roomId];
    const resolved = new Set<string>();
    for (const roomId of roomIds) {
      if (roomId === (Symbols.AnyRoom as string)) {
        for (const known of this.#knownRooms) resolved.add(known);
      } else {
        resolved.add(roomId);
      }
    }
    return [...resolved];
  }

  override validateCapabilities(requested: Set<Capability>): Promise<Set<Capability>> {
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
      const eventId = await this.#core.commands.sendStateEvent(
        target,
        eventType,
        stateKey,
        content
      );
      return { roomId: target, eventId };
    }

    if (eventType === REDACTION_EVENT_TYPE) {
      const redacts = (content as { redacts?: unknown }).redacts;
      if (typeof redacts !== 'string') throw new Error('redaction without a target');
      const reason = (content as { reason?: unknown }).reason;
      const eventId = await this.#core.commands.sendRedaction(
        target,
        redacts,
        typeof reason === 'string' ? reason : null
      );
      return { roomId: target, eventId };
    }

    const eventId = await this.#core.commands.sendRawEvent(target, eventType, content);
    return { roomId: target, eventId };
  }

  override async sendStickyEvent(
    stickyDurationMs: number,
    eventType: string,
    content: unknown,
    roomId: string | null = null
  ): Promise<ISendEventDetails> {
    const target = roomId ?? this.#roomId;
    const eventId = await this.#core.commands.widgetSendStickyEvent(
      target,
      eventType,
      content,
      stickyDurationMs
    );
    return { roomId: target, eventId };
  }

  override async sendDelayedEvent(
    delay: number,
    eventType: string,
    content: unknown,
    stateKey: string | null = null,
    roomId: string | null = null
  ): Promise<ISendDelayedEventDetails> {
    const target = roomId ?? this.#roomId;
    const delayId = await this.#core.commands.widgetSendDelayedEvent(
      target,
      eventType,
      stateKey,
      content,
      delay,
      null
    );
    return { roomId: target, delayId };
  }

  override async sendDelayedStickyEvent(
    delay: number,
    stickyDurationMs: number,
    eventType: string,
    content: unknown,
    roomId: string | null = null
  ): Promise<ISendDelayedEventDetails> {
    const target = roomId ?? this.#roomId;
    const delayId = await this.#core.commands.widgetSendDelayedEvent(
      target,
      eventType,
      null,
      content,
      delay,
      stickyDurationMs
    );
    return { roomId: target, delayId };
  }

  override cancelScheduledDelayedEvent(delayId: string): Promise<void> {
    return this.#core.commands.cancelScheduledMessage(delayId);
  }

  override restartScheduledDelayedEvent(delayId: string): Promise<void> {
    return this.#core.commands.restartDelayedEvent(delayId);
  }

  override sendScheduledDelayedEvent(delayId: string): Promise<void> {
    return this.#core.commands.sendScheduledMessage(delayId);
  }

  override sendToDevice(
    eventType: string,
    encrypted: boolean,
    contentMap: { [userId: string]: { [deviceId: string]: object } }
  ): Promise<void> {
    return this.#core.commands.widgetSendToDevice(eventType, encrypted, contentMap);
  }

  override async readRoomAccountData(
    eventType: string,
    roomIds?: string[] | null
  ): Promise<IRoomAccountData[]> {
    const events = await Promise.all(
      this.#resolveRooms(roomIds).map((roomId) =>
        this.#core.commands.roomAccountDataRaw(roomId, eventType)
      )
    );
    return events.filter((event) => event != null) as IRoomAccountData[];
  }

  override async readStickyEvents(roomId: string): Promise<IRoomEvent[]> {
    return (await this.#core.commands.roomStickyEvents(roomId)) as IRoomEvent[];
  }

  override async readEventRelations(
    eventId: string,
    roomId?: string,
    relationType?: string,
    eventType?: string,
    from?: string,
    to?: string,
    limit?: number,
    direction?: 'f' | 'b'
  ): Promise<IReadEventRelationsResult> {
    const relations = await this.#core.commands.roomEventRelations(
      roomId ?? this.#roomId,
      eventId,
      {
        relType: relationType,
        eventType,
        from,
        to,
        limit,
        direction: direction === undefined ? undefined : direction === 'f' ? 'forward' : 'backward',
      }
    );
    return {
      chunk: relations.chunk as IRoomEvent[],
      nextBatch: relations.next_batch ?? undefined,
      prevBatch: relations.prev_batch ?? undefined,
    };
  }

  override async readRoomTimeline(
    roomId: string,
    eventType: string,
    msgtype: string | undefined,
    stateKey: string | undefined,
    limit: number,
    since: string | undefined
  ): Promise<IRoomEvent[]> {
    const events = await this.#core.commands.roomTimelineEvents(
      roomId,
      eventType,
      msgtype ?? null,
      stateKey ?? null,
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

  override async navigate(uri: string): Promise<void> {
    if (!uri.startsWith(MATRIX_TO_PREFIX)) throw new Error('Invalid matrix.to URI');
    await this.#navigate(uri.slice(MATRIX_TO_PREFIX.length));
  }

  override async *getTurnServers(): AsyncGenerator<ITurnServer> {
    for (;;) {
      const server = await this.#core.commands.turnServer();
      if (server.uris.length === 0) return;
      yield { uris: server.uris, username: server.username, password: server.password };
      const refreshIn = Math.max(TURN_MIN_REFRESH_MS, server.ttl_ms * TURN_REFRESH_FRACTION);
      await new Promise((resolve) => setTimeout(resolve, refreshIn));
    }
  }

  override async getMediaConfig(): Promise<IGetMediaConfigResult> {
    const { upload_size } = await this.#core.commands.mediaConfig();
    return { 'm.upload.size': upload_size };
  }

  override async uploadFile(file: XMLHttpRequestBodyInit): Promise<{ contentUri: string }> {
    const { bytes, mime } = await uploadBytes(file);
    return { contentUri: await this.#core.commands.uploadMedia(mime, bytes) };
  }

  override async downloadFile(contentUri: string): Promise<{ file: XMLHttpRequestBodyInit }> {
    const bytes = await this.#core.commands.fetchMedia(contentUri, 0, 0);
    return { file: new Blob([bytes]) };
  }

  override async getRtcTransports(): Promise<IRtcTransportsResult> {
    return (await this.#core.commands.rtcTransports()) as IRtcTransportsResult;
  }

  override async getRtcLivekitToken(
    data: IRtcLivekitGetTokenFromWidgetRequestData
  ): Promise<IRtcLivekitGetTokenFromWidgetResponseData> {
    return (await this.#core.commands.rtcLivekit(
      'get_token',
      data
    )) as IRtcLivekitGetTokenFromWidgetResponseData;
  }

  override async delegateRtcLivekitDelayedLeave(
    data: IRtcLivekitDelegateDelayedLeaveFromWidgetRequestData
  ): Promise<IRtcLivekitDelegateDelayedLeaveFromWidgetResponseData> {
    return (await this.#core.commands.rtcLivekit(
      'delegate_delayed_leave',
      data
    )) as IRtcLivekitDelegateDelayedLeaveFromWidgetResponseData;
  }

  override getKnownRooms(): string[] {
    return [...this.#knownRooms];
  }

  override processError(error: unknown): IWidgetApiErrorResponseDataDetails | undefined {
    if (!(error instanceof CoreError)) return undefined;
    const mapped = MATRIX_ERRORS[error.detail.code];
    if (mapped === undefined) return undefined;
    return {
      matrix_api_error: {
        http_status: mapped.status,
        http_headers: {},
        url: '',
        response: { errcode: mapped.errcode, error: error.detail.code },
      },
    };
  }
}
