import * as Sentry from '@sentry/sveltekit';

import type { Command } from '#src/generated/Command';
import type { CommandOk } from '#src/generated/CommandOk';
import type { CoreEvent } from '#src/generated/CoreEvent';
import type { WorkerMessage, WorkerRequest } from '#src/worker/protocol';
import wasmVersion from '#src/generated/wasm/sable_wasm_version.js';
import coreWorkerUrl from '../worker/core.worker.ts?sharedworker&url';
import { CoreError, type ResponseFor, type Transport } from './index';
import { on } from 'svelte/events';
import { recordDebugLog } from '../lib/observability/debug-log.svelte.js';
import {
  wasmErrorFingerprint,
  wasmErrorTitle,
  wasmLogLevel,
} from '../lib/observability/wasm-log.js';
import { resetWebStorage } from '../lib/platform/session-storage.js';

type RequestLabel = Command['type'] | 'media' | 'attachment' | 'upload';

const MAX_REPORTED_CORE_ERRORS = 20;
const reportedCoreErrors = new Set<string>();

function reportCoreError(line: string): void {
  if (reportedCoreErrors.size >= MAX_REPORTED_CORE_ERRORS) return;
  const fingerprint = wasmErrorFingerprint(line);
  if (fingerprint === '' || reportedCoreErrors.has(fingerprint)) return;
  reportedCoreErrors.add(fingerprint);
  Sentry.captureMessage(wasmErrorTitle(line), {
    level: 'error',
    fingerprint: ['wasm-core-error', fingerprint],
    tags: { source: 'wasm-core' },
  });
}

function requestLabel(request: WorkerRequest): RequestLabel | undefined {
  if ('command' in request) return request.command.type;
  if ('media' in request) return 'media';
  if ('attachment' in request) return 'attachment';
  if ('upload' in request) return 'upload';
  return undefined;
}

export function createWebTransport(): Transport {
  const listeners = new Set<(event: CoreEvent) => void>();
  // Which reply belongs to which id is a runtime fact, so it cannot be typed.
  type Reply = CommandOk | Uint8Array<ArrayBuffer> | string | null;
  const pending = new Map<
    number,
    { resolve: (value: Reply) => void; reject: (error: unknown) => void }
  >();
  const pendingCommands = new Map<number, RequestLabel>();
  const crashListeners = new Set<(message: string) => void>();
  const stallListeners = new Set<(stalled: boolean) => void>();
  const overdue = new Set<number>();
  let healthProbeId: number | null = null;
  let healthProbeTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  let nextId = 1;
  let worker: SharedWorker | null = null;
  let debugLogs = false;
  let closed = false;

  const stallAfterMs = 20_000;
  const healthProbeTimeoutMs = 2_000;
  const healthProbeIntervalMs = 5_000;

  function reportStall(next: boolean): void {
    if (stalled === next) return;
    stalled = next;
    for (const listener of stallListeners) listener(next);
  }

  function clearHealthProbe(): void {
    if (healthProbeTimer !== undefined) clearTimeout(healthProbeTimer);
    healthProbeTimer = undefined;
    healthProbeId = null;
  }

  function scheduleHealthProbe(delay = 0): void {
    if (closed || overdue.size === 0 || healthProbeTimer !== undefined) {
      return;
    }
    healthProbeTimer = setTimeout(() => {
      healthProbeTimer = undefined;
      if (closed || overdue.size === 0) return;

      const id = nextId++;
      healthProbeId = id;
      connect().port.postMessage({ id, ping: true });
      healthProbeTimer = setTimeout(() => {
        healthProbeTimer = undefined;
        healthProbeId = null;
        reportStall(true);
        scheduleHealthProbe(healthProbeIntervalMs);
      }, healthProbeTimeoutMs);
    }, delay);
  }

  function setOverdue(id: number, isOverdue: boolean): void {
    if (isOverdue) {
      overdue.add(id);
      scheduleHealthProbe();
      return;
    }

    overdue.delete(id);
    if (overdue.size > 0) return;
    clearHealthProbe();
    reportStall(false);
  }

  function rejectPending(logId: string): void {
    const waiting = [...pending.values()];
    pending.clear();
    pendingCommands.clear();
    for (const { reject } of waiting) {
      reject(new CoreError({ code: 'failed', log_id: logId }));
    }
  }

  function handleCrash(message: string): void {
    // The failure crosses as a string, so every one of them carries this file's
    // stack. The fingerprint groups on the Rust `panicked at <path>:<line>`.
    Sentry.captureException(new Error(message), {
      fingerprint: ['wasm-core-crash', message],
      tags: { source: 'wasm-core' },
    });
    worker = null;
    rejectPending(`core panicked: ${message}`);
    for (const listener of crashListeners) listener(message);
  }

  function connect(): SharedWorker {
    if (worker) return worker;

    const workerUrl = new URL(coreWorkerUrl, self.location.href);
    // Shared workers outlive tabs, so changing their URL prevents an old glue
    // module from being paired with a freshly generated WASM binary.
    workerUrl.searchParams.set('wasm', wasmVersion);
    const logFilter = new URLSearchParams(self.location.search).get('log');
    if (logFilter) workerUrl.searchParams.set('log', logFilter);

    const nextWorker = new SharedWorker(workerUrl, {
      type: 'module',
      name: 'sable-core',
    });

    // Only the worker failing to load reaches here. Runtime failures inside it
    // are reported to its own global scope, so the worker forwards those itself.
    on(nextWorker, 'error', (event) => {
      const { message } = event as ErrorEvent;
      console.error('[sable transport] shared worker error', message);
      Sentry.captureException(new Error(`shared worker failed to start: ${message}`), {
        tags: { source: 'wasm-core' },
      });
    });

    nextWorker.port.onmessageerror = (event) => {
      console.error('[sable transport] worker message could not be decoded', event);
    };

    nextWorker.port.onmessage = (message: MessageEvent<WorkerMessage>) => {
      const data = message.data;

      if ('event' in data) {
        for (const listener of listeners) listener(data.event);
        return;
      }

      if ('logs' in data) {
        for (const line of data.logs) {
          const level = wasmLogLevel(line);
          recordDebugLog(level, level === 'error' ? 'error' : 'general', 'wasm', line.trim());
          if (level === 'error') reportCoreError(line);
        }
        return;
      }

      if ('panic' in data) {
        console.error('[sable transport] core panicked', data.panic.message);
        handleCrash(data.panic.message);
        return;
      }

      if ('pong' in data) {
        if (data.id !== healthProbeId) return;
        if (healthProbeTimer !== undefined) clearTimeout(healthProbeTimer);
        healthProbeTimer = undefined;
        healthProbeId = null;
        reportStall(false);
        scheduleHealthProbe(healthProbeIntervalMs);
        return;
      }

      const waiting = pending.get(data.id);
      if (!waiting) return;
      pending.delete(data.id);
      const command = pendingCommands.get(data.id);
      pendingCommands.delete(data.id);

      if ('ok' in data) {
        waiting.resolve(data.ok);
      } else if ('bytes' in data) waiting.resolve(data.bytes);
      else if ('uri' in data) waiting.resolve(data.uri);
      else {
        if (command !== 'media' || data.err.code !== 'unavailable') {
          console.warn('[sable transport] command failed', { command, code: data.err.code });
        }
        waiting.reject(new CoreError(data.err));
      }
    };

    nextWorker.port.start();
    if (debugLogs) nextWorker.port.postMessage({ debugLogs: true });
    worker = nextWorker;
    return nextWorker;
  }

  function detach(reason: string, farewell: WorkerRequest): void {
    closed = true;
    listeners.clear();
    crashListeners.clear();
    stallListeners.clear();
    clearHealthProbe();
    overdue.clear();
    rejectPending(reason);
    worker?.port.postMessage(farewell);
    worker?.port.close();
    worker = null;
  }

  function request<T extends Reply>(
    body: (id: number) => WorkerRequest,
    transfers: Transferable[] = []
  ): Promise<T> {
    return (async () => {
      if (closed) throw new CoreError({ code: 'failed', log_id: 'transport closed' });
      const id = nextId++;
      const activeWorker = connect();

      return new Promise<T>((resolve, reject) => {
        const request = body(id);
        const label = requestLabel(request);
        if (label !== undefined) recordDebugLog('debug', 'network', 'transport', label);
        const timeout =
          label === 'login_flows'
            ? setTimeout(() => {
                if (!pending.delete(id)) return;
                pendingCommands.delete(id);
                console.error('[sable transport] command timed out waiting for worker', {
                  command: label,
                });
                reject(new Error('Timed out waiting for homeserver discovery'));
              }, 20_000)
            : undefined;
        const stall =
          'command' in request
            ? setTimeout(() => {
                setOverdue(id, true);
              }, stallAfterMs)
            : undefined;
        const settle = () => {
          if (timeout !== undefined) clearTimeout(timeout);
          if (stall !== undefined) clearTimeout(stall);
          setOverdue(id, false);
        };
        pending.set(id, {
          resolve: (value) => {
            settle();
            resolve(value as T);
          },
          reject: (error) => {
            settle();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        });
        if (label !== undefined) pendingCommands.set(id, label);
        activeWorker.port.postMessage(request, transfers);
      });
    })();
  }

  return {
    send<C extends Command>(command: C) {
      return request<ResponseFor<C['type']>>((id) => ({ id, command }));
    },

    fetchMedia(source, width, height) {
      return request<Uint8Array<ArrayBuffer>>((id) => ({
        id,
        media: { source, width, height },
      }));
    },

    async sendAttachment({ roomId, filename, mime, bytes, caption, inReplyTo, info, threadRoot }) {
      await request<null>(
        (id) => ({
          id,
          attachment: {
            roomId,
            filename,
            mime,
            bytes,
            caption: caption ?? null,
            inReplyTo: inReplyTo ?? null,
            info: info ?? null,
            threadRoot: threadRoot ?? null,
          },
        }),
        [bytes.buffer]
      );
    },

    async uploadMedia(mime, bytes) {
      const uri = await request<string | null>(
        (id) => ({ id, upload: { mime, bytes } }),
        [bytes.buffer]
      );

      // The worker only answers `uri: null` to `attachment`, which has no URI.
      return uri ?? '';
    },

    setDebugLogs(enabled) {
      debugLogs = enabled;
      worker?.port.postMessage({ debugLogs: enabled });
    },

    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },

    subscribeCrash(onCrash) {
      crashListeners.add(onCrash);
      return () => crashListeners.delete(onCrash);
    },

    subscribeStall(onStall) {
      stallListeners.add(onStall);
      return () => stallListeners.delete(onStall);
    },

    async resetCaches() {
      await request<null>((id) => ({ id, reset: true }));
      detach('cache reset', { disconnect: true });
      await resetWebStorage();
    },

    close() {
      detach('transport closed', { disconnect: true });
    },
  };
}
