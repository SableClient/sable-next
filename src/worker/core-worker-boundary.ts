import type { CommandErr } from '#src/generated/CommandErr';
import type { CommandOk } from '#src/generated/CommandOk';
import type { CoreEvent } from '#src/generated/CoreEvent';
import type { WorkerMessage, WorkerRequest } from './protocol';
import { TimelineEventRouter } from './timeline-event-router';

const logFlushMs = 250;
const logBufferLimit = 500;

export type WorkerCore = {
  submitCommand(command: string): Promise<string>;
  fetchMedia(source: string, width: number, height: number): Promise<Uint8Array>;
  sendAttachment(
    roomId: string,
    filename: string,
    mime: string,
    bytes: Uint8Array<ArrayBuffer>,
    caption: string | null,
    inReplyTo: string | null,
    info: string | null,
    threadRoot: string | null
  ): Promise<void>;
  uploadMedia(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
};

export type WorkerPort = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent<WorkerRequest>) => unknown) | null;
  onmessageerror: ((event: MessageEvent) => unknown) | null;
  start(): void;
};

/** Owns page ports and enforces timeline subscription ownership at the worker boundary. */
export function createCoreWorkerBoundary(
  core: Promise<WorkerCore>,
  setLogCapture: (enabled: boolean) => void = () => {},
  terminate: () => void = () => {}
) {
  const ports = new Set<WorkerPort>();
  const timelineEvents = new TimelineEventRouter<WorkerPort>();
  let panic: string | null = null;
  let logs: string[] = [];
  let droppedLogs = 0;
  let flushLogsTimer: ReturnType<typeof setTimeout> | undefined;

  function closePort(port: WorkerPort): void {
    ports.delete(port);
    const subscriptions = timelineEvents.removeOwner(port);
    if (subscriptions.length === 0) return;

    void core.then(async (instance) => {
      for (const subscription of subscriptions) {
        try {
          await instance.submitCommand(JSON.stringify({ type: 'unsubscribe', subscription }));
        } catch {
          // The owner is gone, so cleanup errors cannot be reported to a page.
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

  function handlePanic(message: string): void {
    panic ??= message;
    broadcast({ panic: { message } });
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
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (logs.length >= logBufferLimit) {
        droppedLogs += 1;
        continue;
      }
      logs.push(line.trimEnd());
    }
    flushLogsTimer ??= setTimeout(flushLogs, logFlushMs);
  }

  /** `json` is a `CoreEvent[]`: the core batches whatever had queued up. */
  function handleEvent(json: string): void {
    for (const event of JSON.parse(json) as CoreEvent[]) {
      if (event.type === 'timeline_diff' || event.type === 'timeline_pagination') {
        const owner = timelineEvents.route(event);
        if (!owner) continue;
        try {
          owner.postMessage({ event });
        } catch {
          closePort(owner);
        }
        continue;
      }
      broadcast({ event });
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
            err: { code: 'failed', log_id: 'close other Sable tabs before resetting the cache' },
          });
          return;
        }
        closePort(port);
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
      if ('ping' in request) {
        port.postMessage({ id: request.id, pong: true });
        return;
      }
      const { id } = request;

      if (panic !== null) {
        port.postMessage({ id, err: { code: 'failed', log_id: `core panicked: ${panic}` } });
        return;
      }

      try {
        const instance = await core;
        if ('media' in request) {
          const { source, width, height } = request.media;
          // wasm-bindgen copies into a fresh, unshared ArrayBuffer but types it
          // only as `ArrayBufferLike`.
          const bytes = (await instance.fetchMedia(
            source,
            width,
            height
          )) as Uint8Array<ArrayBuffer>;
          port.postMessage({ id, bytes } satisfies WorkerMessage, [bytes.buffer]);
          return;
        }
        if ('attachment' in request) {
          const { roomId, filename, mime, bytes, caption, inReplyTo, info, threadRoot } =
            request.attachment;
          await instance.sendAttachment(
            roomId,
            filename,
            mime,
            bytes,
            caption,
            inReplyTo,
            info === null ? null : JSON.stringify(info),
            threadRoot
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
        if (
          (request.command.type === 'paginate' || request.command.type === 'unsubscribe') &&
          !timelineEvents.owns(request.command.subscription, port)
        ) {
          port.postMessage({ id, err: { code: 'denied' } } satisfies WorkerMessage);
          return;
        }

        const timelineRequest = request.command.type === 'subscribe_timeline';
        if (timelineRequest) timelineEvents.begin(port);
        const ok = JSON.parse(
          await instance.submitCommand(JSON.stringify(request.command))
        ) as CommandOk;
        if (ok.type === 'subscribe_timeline') {
          const events = timelineEvents.claim(ok.subscription, port);
          if (!events || !ports.has(port)) {
            await instance.submitCommand(
              JSON.stringify({ type: 'unsubscribe', subscription: ok.subscription })
            );
            return;
          }
          port.postMessage({ id, ok });
          for (const event of events) port.postMessage({ event });
          return;
        }
        if (request.command.type === 'unsubscribe') {
          timelineEvents.release(request.command.subscription);
        }
        port.postMessage({ id, ok });
      } catch (cause) {
        if ('command' in request && request.command.type === 'subscribe_timeline') {
          timelineEvents.cancelPending(port);
        }
        let err: CommandErr = { code: 'failed', log_id: String(cause) };
        if (typeof cause === 'string') {
          try {
            err = JSON.parse(cause) as CommandErr;
          } catch {
            console.error('[sable worker] core rejected with a non-protocol error', cause);
          }
        }
        port.postMessage({ id, err });
      }
    };
    port.start();
  }

  return { connect, handleEvent, handleLog, handlePanic };
}
