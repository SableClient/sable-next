import { attachmentBytes } from '../transport/attachment-bytes';
import type { CoreEvent, RpcError } from '#src/generated/protocol';
import type { WorkerMessage, WorkerRequest } from './protocol';

const logFlushMs = 250;
const logBufferLimit = 500;
const logLevelPrefix = /^\s*(TRACE|DEBUG|INFO|WARN|ERROR)\s/;

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

/** Owns the page ports and carries the core's events and calls across them. */
export function createCoreWorkerBoundary(
  core: Promise<WorkerCore>,
  setLogCapture: (enabled: boolean) => void = () => {},
  terminate: () => void = () => {},
  setLogFilter: (filter: string) => void = () => {},
  stop: () => Promise<void> = () => Promise.resolve()
) {
  const ports = new Set<WorkerPort>();
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

  function closePort(port: WorkerPort): void {
    ports.delete(port);
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

  function handlePanic(message: string, stack?: string): void {
    panic ??= message;
    broadcast({
      panic: stack === undefined ? { message } : { message, stack },
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

  function handleLog(text: string): void {
    const entries: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const last = entries.length - 1;
      if (last >= 0 && !logLevelPrefix.test(line)) entries[last] += `\n${line.trimEnd()}`;
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
    broadcast({ events: JSON.parse(json) as CoreEvent[] });
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
            err: {
              code: 'failed',
              log_id: 'close other Sable tabs before resetting the cache',
            },
          });
          return;
        }
        closePort(port);
        // The page clears the stores once answered, so nothing may still write to them.
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

      if (panic !== null) {
        port.postMessage({
          id,
          err: { code: 'failed', log_id: `core panicked: ${panic}` },
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
              attachments: attachments.map(({ filename, mime, info = null }) => ({
                filename,
                mime,
                info,
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
        if ('call' in request) {
          const { method } = request.call;
          const params = JSON.stringify(request.call.params);
          const ok: unknown = JSON.parse(await instance.call(method, params));
          port.postMessage({ id, ok } satisfies WorkerMessage);
          return;
        }
      } catch (cause) {
        const payload = rejectionPayload(cause);
        let err: RpcError = { code: 'failed', log_id: payload || String(cause) };
        if (payload) {
          try {
            err = JSON.parse(payload) as RpcError;
          } catch {
            console.error('[sable worker] core rejected with a non-protocol error', cause);
          }
        }
        port.postMessage({ id, err });
      }
    };
    port.start();
  }

  return {
    connect,
    handleEvent,
    handleLog,
    handlePanic,
    handleSuperseded,
    handleOnline: resumeSync,
  };
}
