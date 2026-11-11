import { attachmentBytes } from '../transport/attachment-bytes';
import { transportFailure } from '../transport';
import { createRpc } from '#src/generated/protocol';
import type { RpcError, RpcResult, CoreEvent, SubscriptionId, Rpc } from '#src/generated/protocol';
import type { WasmDebugImage, WorkerMessage, WorkerRequest } from './protocol';
import { TimelineEventRouter } from './timeline-event-router';
import { readCoreLine } from '../lib/observability/wasm-log';

const logFlushMs = 250;
const logBufferLimit = 500;
const logLevelPrefix = /^\s*(TRACE|DEBUG|INFO|WARN|ERROR)\s/;

function startsLogEntry(line: string): boolean {
  return readCoreLine(line).reported || logLevelPrefix.test(line);
}

export type WorkerCore = {
  call(method: string, params: string): Promise<string>;
  fetchMedia(
    source: string,
    width: number,
    height: number,
    background: boolean
  ): Promise<Uint8Array>;
  forgetMedia(source: string): Promise<void>;
  sendAttachment(request: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  sendGallery(request: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  uploadMedia(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  rtcData(sessionId: string, frame: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
  setActive(active: boolean): Promise<void>;
};

export type WorkerPort = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent<WorkerRequest>) => unknown) | null;
  onmessageerror: ((event: MessageEvent) => unknown) | null;
  start(): void;
};

/** The core rejects with the protocol payload: a bare string from the wasm build, an Error carrying it from the native one. */
function rejectionPayload(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : '';
}

/** Owns page ports and enforces timeline subscription ownership at the worker boundary. */
export function createCoreWorkerBoundary(
  core: Promise<WorkerCore>,
  setLogCapture: (enabled: boolean) => void = () => {},
  terminate: () => void = () => {},
  setLogFilter: (filter: string) => void = () => {},
  stop: () => Promise<void> = () => Promise.resolve(),
  onCall: (method: string, elapsedMs: number) => void = () => {}
) {
  async function timedCall(instance: WorkerCore, method: string, params: string): Promise<string> {
    const started = performance.now();
    try {
      return await instance.call(method, params);
    } finally {
      onCall(method, performance.now() - started);
    }
  }

  const ports = new Set<WorkerPort>();
  const visibility = new Map<WorkerPort, boolean>();
  let foreground: boolean | undefined;
  let foregroundTask = Promise.resolve();
  const timelineEvents = new TimelineEventRouter<WorkerPort>();
  let panic: string | null = null;
  let logs: string[] = [];
  let droppedLogs = 0;
  let flushLogsTimer: ReturnType<typeof setTimeout> | undefined;

  // Hiding never stops sync: background tabs must keep notifying (#1142).
  function resumeSync(): void {
    void core
      .then((instance) => instance.setActive(true))
      .catch((error: unknown) => {
        console.debug('[sable worker] sync activity not applied', error);
      });
  }

  function anyVisible(): boolean {
    return [...visibility.values()].some(Boolean);
  }

  function updateForeground(): void {
    const visible = anyVisible();
    if (foreground === visible || (foreground === undefined && visibility.size === 0)) return;
    foreground = visible;
    foregroundTask = foregroundTask
      .then(async () => {
        const instance = await core;
        await instance.call(
          'session.set_app_in_foreground',
          JSON.stringify({ foreground: visible })
        );
      })
      .catch((error: unknown) => {
        console.debug('[sable worker] foreground not applied', error);
      });
  }

  function closePort(port: WorkerPort): void {
    if (!ports.delete(port)) return;
    visibility.delete(port);
    port.onmessage = null;
    port.onmessageerror = null;
    updateForeground();
    const subscriptions = timelineEvents.removeOwner(port);
    if (subscriptions.length === 0) return;

    void core.then(async (instance) => {
      for (const subscription of subscriptions) {
        try {
          await createRpc(async (method, params) =>
            instance.call(method, JSON.stringify(params))
          ).timeline.unsubscribe({ subscription });
        } catch (error) {
          // The owner is gone, so cleanup errors cannot be reported to a page.
          console.debug('[sable worker] closed port subscription not released', error);
        }
      }
    });
  }

  function broadcast(message: WorkerMessage): void {
    for (const port of ports) {
      try {
        port.postMessage(message);
      } catch {
        closePort(port);
      }
    }
  }

  function handlePanic(message: string, stack?: string, wasm?: WasmDebugImage): void {
    panic ??= message;
    broadcast({
      panic: { message, stack, wasm },
    });
  }

  function handleSuperseded(): void {
    broadcast({ superseded: true });
  }

  function flushLogs(): void {
    if (flushLogsTimer !== undefined) clearTimeout(flushLogsTimer);
    flushLogsTimer = undefined;
    const batch = logs;
    logs = [];
    if (batch.length === 0) return;
    const dropped = droppedLogs;
    droppedLogs = 0;
    broadcast({
      logs: dropped === 0 ? batch : [...batch, `+${dropped} core log lines dropped`],
    });
  }

  function handleSpan(name: string, startMs: number, durationMs: number): void {
    broadcast({ span: { name, startMs, durationMs } });
  }

  function handleLog(text: string): void {
    const entries: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const last = entries.length - 1;
      if (last >= 0 && !startsLogEntry(line)) entries[last] += `\n${line.trimEnd()}`;
      else entries.push(line.trimEnd());
    }
    for (const entry of entries) {
      if (logs.length >= logBufferLimit) {
        droppedLogs += 1;
        continue;
      }
      logs.push(entry);
    }
    flushLogsTimer ??= setTimeout(flushLogs, logFlushMs);
  }

  /** `json` is a `CoreEvent[]`: the core batches whatever had queued up. */
  function handleEvent(json: string): void {
    const shared: CoreEvent[] = [];
    const routed = new Map<WorkerPort, CoreEvent[]>();

    for (const event of JSON.parse(json) as CoreEvent[]) {
      if (event.type === 'timeline_diff' || event.type === 'timeline_pagination') {
        const owner = timelineEvents.route(event);
        if (!owner) continue;
        const batch = routed.get(owner);
        if (batch) batch.push(event);
        else routed.set(owner, [event]);
        continue;
      }
      // Every page reports what it receives, so a failure goes to one of them.
      if (event.type === 'failure') {
        const reporter = ports.values().next().value;
        if (!reporter) continue;
        const batch = routed.get(reporter);
        if (batch) batch.push(event);
        else routed.set(reporter, [event]);
        continue;
      }
      shared.push(event);
    }

    if (shared.length > 0) broadcast({ events: shared });
    for (const [owner, events] of routed) {
      try {
        owner.postMessage({ events });
      } catch {
        closePort(owner);
      }
    }
  }

  function connect(port: WorkerPort): void {
    ports.add(port);
    port.onmessageerror = () => {
      closePort(port);
    };
    port.onmessage = async ({ data: request }) => {
      if ('disconnect' in request) {
        closePort(port);
        return;
      }
      if ('reset' in request) {
        if (ports.size !== 1) {
          port.postMessage({
            id: request.id,
            err: transportFailure('close other Sable tabs before resetting the cache'),
          });
          return;
        }
        closePort(port);
        // The page clears the stores once answered, so nothing may still write to them.
        await foregroundTask;
        await stop();
        port.postMessage({ id: request.id, uri: null });
        terminate();
        return;
      }
      if ('debugLogs' in request) {
        setLogCapture(request.debugLogs);
        if (!request.debugLogs) {
          if (flushLogsTimer !== undefined) clearTimeout(flushLogsTimer);
          flushLogsTimer = undefined;
          logs = [];
          droppedLogs = 0;
        }
        return;
      }
      if ('visible' in request) {
        visibility.set(port, request.visible);
        updateForeground();
        if (request.visible) resumeSync();
        return;
      }
      if ('logFilter' in request) {
        setLogFilter(request.logFilter);
        return;
      }
      if ('ping' in request) {
        port.postMessage({ id: request.id, pong: true });
        return;
      }
      const { id } = request;
      let pendingTimeline = false;

      if (panic !== null) {
        port.postMessage({
          id,
          err: transportFailure(`core panicked: ${panic}`),
        });
        return;
      }

      try {
        const instance = await core;
        if ('media' in request) {
          const { source, width, height, background = false } = request.media;
          // wasm-bindgen copies into a fresh, unshared ArrayBuffer but types it
          // only as `ArrayBufferLike`.
          const bytes = (await instance.fetchMedia(
            source,
            width,
            height,
            background
          )) as Uint8Array<ArrayBuffer>;
          port.postMessage({ id, bytes } satisfies WorkerMessage, [bytes.buffer]);
          return;
        }
        if ('forget' in request) {
          await instance.forgetMedia(request.forget.source);
          port.postMessage({ id, uri: null } satisfies WorkerMessage);
          return;
        }
        if ('attachment' in request) {
          const {
            roomId,
            filename,
            mime,
            bytes,
            thumbnail,
            caption,
            inReplyTo,
            silentReply,
            info,
            threadRoot,
            formattedCaption,
            mentions,
            mentionsRoom,
            persona,
            spoiler,
          } = request.attachment;
          await instance.sendAttachment(
            JSON.stringify({
              room_id: roomId,
              filename,
              mime,
              caption,
              in_reply_to: inReplyTo,
              silent_reply: silentReply,
              info,
              thread_root: threadRoot,
              formatted_caption: formattedCaption,
              mentions,
              mentions_room: mentionsRoom,
              persona,
              spoiler,
            }),
            attachmentBytes([{ bytes, thumbnail }])
          );
          port.postMessage({ id, uri: null } satisfies WorkerMessage);
          return;
        }
        if ('gallery' in request) {
          const {
            roomId,
            attachments,
            caption,
            inReplyTo,
            silentReply,
            threadRoot,
            formattedCaption,
            mentions,
            mentionsRoom,
            persona,
          } = request.gallery;
          await instance.sendGallery(
            JSON.stringify({
              room_id: roomId,
              attachments: attachments.map(({ filename, mime, info = null, spoiler = false }) => ({
                filename,
                mime,
                info,
                spoiler,
              })),
              caption,
              in_reply_to: inReplyTo,
              silent_reply: silentReply,
              thread_root: threadRoot,
              formatted_caption: formattedCaption,
              mentions,
              mentions_room: mentionsRoom,
              persona: persona ?? null,
            }),
            attachmentBytes(attachments)
          );
          port.postMessage({ id, uri: null } satisfies WorkerMessage);
          return;
        }
        if ('upload' in request) {
          const { mime, bytes } = request.upload;
          const uri = await instance.uploadMedia(mime, bytes);
          port.postMessage({ id, uri } satisfies WorkerMessage);
          return;
        }
        if ('rtc' in request) {
          const { sessionId, frame } = request.rtc;
          const bytes = (await instance.rtcData(sessionId, frame)) as Uint8Array<ArrayBuffer>;
          port.postMessage({ id, bytes } satisfies WorkerMessage, [bytes.buffer]);
          return;
        }
        if ('call' in request) {
          const { method } = request.call;
          // Pages report visibility on connect; the worker owns the aggregate across tabs.
          if (method === 'session.set_app_in_foreground') {
            port.postMessage({ id, ok: null } satisfies WorkerMessage);
            return;
          }
          const params = JSON.stringify(request.call.params);
          if (method === 'timeline.paginate' || method === 'timeline.unsubscribe') {
            const { subscription } = request.call.params as {
              subscription: SubscriptionId;
            };
            if (!timelineEvents.owns(subscription, port)) {
              port.postMessage({
                id,
                err: { code: 'denied' },
              } satisfies WorkerMessage);
              return;
            }
          }

          if (method === 'timeline.subscribe') {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              if (!ports.has(port)) return;
              timelineEvents.begin(port);
              pendingTimeline = true;
              const ok = JSON.parse(await timedCall(instance, method, params)) as RpcResult<
                Rpc['timeline']['subscribe']
              >;
              if (typeof ok.subscription !== 'number')
                throw new Error('Invalid timeline subscription response');
              const events = timelineEvents.claim(ok.subscription, port);
              pendingTimeline = false;
              if (events === null || events === 'overflow' || !ports.has(port)) {
                await instance.call(
                  'timeline.unsubscribe',
                  JSON.stringify({ subscription: ok.subscription })
                );
                if (events === 'overflow' && ports.has(port)) continue;
                return;
              }
              port.postMessage({ id, ok });
              if (events.length > 0) port.postMessage({ events });
              return;
            }
            throw new Error('Timeline startup overflowed; retry opening the room');
          }
          const ok: unknown = JSON.parse(await timedCall(instance, method, params));
          if (method === 'timeline.unsubscribe') {
            timelineEvents.release(
              (request.call.params as { subscription: SubscriptionId }).subscription
            );
          }
          port.postMessage({ id, ok } satisfies WorkerMessage);
          return;
        }
      } catch (cause) {
        if (pendingTimeline) {
          timelineEvents.cancelPending(port);
        }
        const payload = rejectionPayload(cause);
        let err = transportFailure(payload || String(cause));
        if (payload) {
          try {
            err = JSON.parse(payload) as RpcError;
          } catch {
            console.error('[sable worker] core rejected with a non-protocol error', cause);
          }
        }
        if (ports.has(port)) port.postMessage({ id, err });
      }
    };
    port.start();
  }

  return {
    connect,
    handleEvent,
    handleLog,
    handleSpan,
    handlePanic,
    handleSuperseded,
  };
}
