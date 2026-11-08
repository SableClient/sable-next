import type { CoreEvent, RpcError } from '#src/generated/protocol';
import { WebSocket as ReconnectingWebSocket } from 'partysocket';
import { stringToBase64 } from 'uint8array-extras';

import { boundServerIdentity } from '#lib/notifications/room-names.js';
import { CoreError, type Attachment, type Gallery, type Transport } from './index';
import { attachmentBytes } from './attachment-bytes';

export type WsTransportOptions = {
  url: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type ServerMessage = {
  server?: { version?: string; run_id?: string; user_id?: string };
  event?: CoreEvent;
  seq?: number;
  run_id?: string;
  reset?: boolean;
  id?: number;
  ok?: unknown;
  error?: unknown;
};

function errorDetail(value: unknown): RpcError {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = value.code;
    if (typeof code === 'string') return value as RpcError;
  }
  return { code: 'failed', log_id: 'invalid server error' };
}

function websocketUrl(url: string, runId: string | null, lastReceivedEvent: number): string {
  const parsed = new URL(url, location.href);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  const identity = boundServerIdentity();
  if (identity) parsed.searchParams.set('user_id', identity);
  if (runId) parsed.searchParams.set('run_id', runId);
  if (lastReceivedEvent > 0)
    parsed.searchParams.set('last_received_event', String(lastReceivedEvent));
  return parsed.toString();
}

function httpUrl(url: string, path: string): string {
  const parsed = new URL(url, location.href);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return new URL(path, parsed).toString();
}

function encodedBytes(value: string): string {
  return stringToBase64(value, { urlSafe: true });
}

async function responseError(response: Response): Promise<CoreError> {
  try {
    return new CoreError(errorDetail(await response.json()));
  } catch {
    return new CoreError({ code: 'failed', log_id: `server returned HTTP ${response.status}` });
  }
}

const RELOAD_KEY = 'sable-server-last-reload';
const RELOAD_INTERVAL_MS = 30_000;

function guardedReload(): void {
  const last = Number(sessionStorage.getItem(RELOAD_KEY));
  if (Date.now() - last < RELOAD_INTERVAL_MS) return;
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  location.reload();
}

function checkServerBuild(version?: string): void {
  const expectedVersion = import.meta.env.VITE_SABLE_SERVER_VERSION;
  if (!expectedVersion || !version || expectedVersion === version) return;

  const key = 'sable-server-last-update';
  if (localStorage.getItem(key) === version) return;
  localStorage.setItem(key, version);
  location.reload();
}

export function createWsTransport(options: WsTransportOptions): Transport {
  const listeners = new Set<(event: CoreEvent) => void>();
  const stallListeners = new Set<(stalled: boolean) => void>();
  const pending = new Map<number, Pending>();
  let socket: ReconnectingWebSocket | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  let closed = false;
  let stalled = false;
  let runId: string | null = null;
  let lastReceivedEvent = 0;
  let lastSessionRefresh = Date.now();
  let sessionRefresh: Promise<void> | null = null;
  let checkAfterRefresh = false;

  function refreshSession(recheck = false): void {
    if (closed) return;
    if (sessionRefresh) {
      checkAfterRefresh ||= recheck;
      return;
    }
    sessionRefresh = fetchServer('/_sable/identity')
      .then((response) => {
        if (response.status === 401 || response.status === 403) guardedReload();
        else if (response.ok) lastSessionRefresh = Date.now();
      })
      .catch((error: unknown) => {
        console.debug('[sable transport] server session refresh failed', error);
      })
      .finally(() => {
        sessionRefresh = null;
        if (checkAfterRefresh) {
          checkAfterRefresh = false;
          refreshSession();
        }
      });
  }

  function handleMessage(text: string): void {
    let data: ServerMessage;
    try {
      data = JSON.parse(text) as ServerMessage;
    } catch {
      socket?.reconnect(1003, 'invalid JSON');
      return;
    }

    if (data.server) {
      const identity = boundServerIdentity();
      if (identity && data.server.user_id !== identity) {
        socket?.close();
        guardedReload();
        return;
      }
      runId = data.server.run_id ?? runId;
      checkServerBuild(data.server.version);
      return;
    }
    if (data.reset) {
      guardedReload();
      return;
    }
    if (data.event) {
      if (typeof data.seq === 'number' && data.seq <= lastReceivedEvent) return;
      if (typeof data.seq === 'number') lastReceivedEvent = data.seq;
      for (const listener of listeners) listener(data.event);
      return;
    }
    if (typeof data.id !== 'number') return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (pending.size === 0 && stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
    setStalled(false);
    if ('ok' in data) request.resolve(data.ok);
    else request.reject(new CoreError(errorDetail(data.error)));
  }

  function setStalled(next: boolean): void {
    if (stalled === next) return;
    stalled = next;
    for (const listener of stallListeners) listener(next);
  }

  function rejectPending(message: string): void {
    const error = new CoreError({ code: 'failed', log_id: message });
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
    setStalled(false);
  }

  function connect(): void {
    if (closed || socket) return;
    const next = new ReconnectingWebSocket(
      () => websocketUrl(options.url, runId, lastReceivedEvent),
      undefined,
      {
        minReconnectionDelay: 250,
        maxReconnectionDelay: 10_000,
        reconnectionDelayGrowFactor: 2,
      }
    );
    socket = next;
    next.onopen = () => {
      setStalled(false);
    };
    next.onmessage = (message) => {
      if (typeof message.data === 'string') {
        handleMessage(message.data);
      } else {
        next.reconnect(1003, 'unexpected binary websocket message');
      }
    };
    next.onclose = () => {
      if (socket !== next) return;
      next.drainQueuedMessages();
      rejectPending('websocket closed');
      refreshSession(true);
    };
  }

  function request(method: string, params: unknown): Promise<unknown> {
    if (Date.now() - lastSessionRefresh >= 5 * 60_000) refreshSession();
    if (closed)
      return Promise.reject(new CoreError({ code: 'failed', log_id: 'transport closed' }));
    const id = nextId++;
    const message = JSON.stringify({ id, method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    if (stallTimer === undefined) {
      stallTimer = setTimeout(() => {
        stallTimer = undefined;
        setStalled(true);
      }, 20_000);
    }
    connect();
    socket?.send(message);
    return promise;
  }

  async function fetchServer(path: string, init?: RequestInit): Promise<Response> {
    const identity = boundServerIdentity();
    if (!identity) throw new Error('server identity unavailable');
    const headers = new Headers(init?.headers);
    headers.set('x-sable-user', identity);
    return fetch(httpUrl(options.url, path), { ...init, headers, credentials: 'include' });
  }

  async function sendBinary(
    path: string,
    request: object,
    bytes: Uint8Array<ArrayBuffer>
  ): Promise<void> {
    const response = await fetchServer(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-sable-request': encodedBytes(JSON.stringify(request)),
      },
      body: bytes,
    });
    if (!response.ok) throw await responseError(response);
  }

  connect();

  return {
    call: request,

    async fetchMedia(source, width, height, background = false) {
      const parsed = source.startsWith('mxc://') ? new URL(source) : null;
      const server = parsed?.host ?? 'media';
      const mediaId = parsed?.pathname.slice(1) ?? 'source';
      const query = new URLSearchParams({ width: String(width), height: String(height) });
      if (background) query.set('background', 'true');
      if (width > 0 || height > 0) query.set('inline', 'true');
      if (!parsed) query.set('source', encodedBytes(source));
      const response = await fetchServer(
        `/_sable/media/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}?${query}`,
        { cache: 'no-store' }
      );
      if (!response.ok) throw await responseError(response);
      return new Uint8Array(await response.arrayBuffer());
    },

    async forgetMedia(source) {
      const response = await fetchServer('/_sable/media/forget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      if (!response.ok) throw await responseError(response);
    },

    async sendAttachment(attachment: Attachment) {
      const { bytes, thumbnail, ...requestData } = attachment;
      await sendBinary(
        '/_sable/send-attachment',
        {
          room_id: requestData.roomId,
          filename: requestData.filename,
          mime: requestData.mime,
          caption: requestData.caption ?? null,
          formatted_caption: requestData.formattedCaption ?? null,
          mentions: requestData.mentions ?? [],
          mentions_room: requestData.mentionsRoom ?? false,
          in_reply_to: requestData.inReplyTo ?? null,
          silent_reply: requestData.silentReply ?? false,
          info: requestData.info ?? null,
          thread_root: requestData.threadRoot ?? null,
          persona: requestData.persona ?? null,
          spoiler: requestData.spoiler ?? false,
        },
        attachmentBytes([{ bytes, thumbnail }])
      );
    },

    async sendGallery(gallery: Gallery) {
      await sendBinary(
        '/_sable/send-gallery',
        {
          room_id: gallery.roomId,
          attachments: gallery.attachments.map(
            ({ filename, mime, info = null, spoiler = false }) => ({
              filename,
              mime,
              info,
              spoiler,
            })
          ),
          caption: gallery.caption ?? null,
          formatted_caption: gallery.formattedCaption ?? null,
          mentions: gallery.mentions ?? [],
          mentions_room: gallery.mentionsRoom ?? false,
          in_reply_to: gallery.inReplyTo ?? null,
          silent_reply: gallery.silentReply ?? false,
          thread_root: gallery.threadRoot ?? null,
          persona: gallery.persona ?? null,
        },
        attachmentBytes(gallery.attachments)
      );
    },

    async uploadMedia(mime, bytes) {
      const response = await fetchServer('/_sable/upload', {
        method: 'POST',
        headers: { 'content-type': mime },
        body: bytes,
      });
      if (!response.ok) throw await responseError(response);
      return (await response.json()) as string;
    },

    async rtcData(sessionId, frame) {
      const response = await fetchServer(`/_sable/rtc/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: frame,
      });
      if (!response.ok) throw await responseError(response);
      return new Uint8Array(await response.arrayBuffer());
    },

    setDebugLogs() {},

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscribeCrash() {
      return () => {};
    },

    subscribeSuperseded() {
      return () => {};
    },

    subscribeStall(listener) {
      stallListeners.add(listener);
      return () => stallListeners.delete(listener);
    },

    async resetCaches() {
      await request('session.reset_local_cache', {});
    },

    deleteAccountStore() {
      return Promise.resolve();
    },

    close() {
      if (closed) return;
      closed = true;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
      rejectPending('transport closed');
      const current = socket;
      socket = null;
      current?.drainQueuedMessages();
      current?.close(1000, 'client closed');
      listeners.clear();
      stallListeners.clear();
    },
  };
}
