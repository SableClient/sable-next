import * as Sentry from '@sentry/sveltekit';

import type { CoreEvent } from '#src/generated/protocol';
import type { WorkerMessage, WorkerRequest } from '#src/worker/protocol';
import wasmVersion from '#src/generated/wasm/sable_wasm_version.js';
import coreWorkerUrl from '../worker/core.worker.ts?sharedworker&url';
import { CoreError, type Transport } from './index';
import { on } from 'svelte/events';
import { recordDebugLog } from '../lib/observability/debug-log.svelte.js';
import {
  isReportableCoreWarning,
  isUndecryptableToDevice,
  isExpectedCoreFailure,
  wasmErrorFingerprint,
  wasmErrorTitle,
  wasmLogLevel,
} from '../lib/observability/wasm-log.js';
import { readText, writeText } from '../lib/platform/local-json.js';
import { deleteAccountWebStorage, resetWebStorage } from '../lib/platform/session-storage.js';
import { migrateV1 } from '#lib/migrations/v1/migration.js';

const QUIET_COMMAND_FAILURES = new Set([
  'media:unavailable',
  'account.user_profile:unavailable',
  'timeline.unsubscribe:denied',
  'timeline.unsubscribe:unknown_subscription',
]);

const reportedCoreErrors = new Set<string>();

function isStorageFailure(line: string): boolean {
  return /database without an in-progress transaction|connection to indexed database server lost|database connection is closing|TransactionAborted/i.test(
    line
  );
}

function reportCoreError(line: string, onStorageFailure: () => void): void {
  const storage = isStorageFailure(line);
  if (storage) onStorageFailure();
  if (isExpectedCoreFailure(line)) {
    Sentry.addBreadcrumb({
      category: 'core.sync',
      level: 'warning',
      message: wasmErrorTitle(line),
    });
    return;
  }
  const fingerprint = wasmErrorFingerprint(line);
  if (fingerprint === '' || reportedCoreErrors.has(fingerprint)) return;
  reportedCoreErrors.add(fingerprint);
  Sentry.captureException(Object.assign(new Error(wasmErrorTitle(line)), { name: 'CoreLog' }), {
    level: storage ? 'warning' : 'error',
    fingerprint: ['wasm-core-error', fingerprint],
    tags: { source: 'wasm-core' },
  });
}

function requestLabel(request: WorkerRequest): string | undefined {
  if ('call' in request) return request.call.method;
  if ('media' in request) return 'media';
  if ('attachment' in request) return 'attachment';
  if ('upload' in request) return 'upload';
  return undefined;
}

interface PrewarmedWorker {
  worker: SharedWorker;
  generation: number;
  failure: string | null;
}

let prewarmed: PrewarmedWorker | null = null;

function storedLogFilter(): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as {
      coreLogLevel?: unknown;
      developerTools?: unknown;
    };
    if (stored.developerTools !== true || stored.coreLogLevel !== 'debug') return null;
    return 'debug,matrix_sdk::latest_events::latest_event::builder=off,matrix_sdk_base::room::display_name=off';
  } catch {
    return null;
  }
}

const GENERATION_KEY = 'sable-core-generation';

function readGeneration(): number {
  const stored = Number(readText(GENERATION_KEY));
  return Number.isInteger(stored) && stored > 0 ? stored : 0;
}

/** The browser reuses a shared worker by name, and a panicked one cannot be reused. */
function retireGeneration(used: number): void {
  if (readGeneration() <= used) writeText(GENERATION_KEY, String(used + 1));
}

function openWorker(generation: number): SharedWorker {
  const workerUrl = new URL(coreWorkerUrl, self.location.href);
  // Shared workers outlive tabs, so changing their URL prevents an old glue
  // module from being paired with a freshly generated WASM binary.
  workerUrl.searchParams.set('wasm', wasmVersion);
  const matchMedia = Reflect.get(globalThis, 'matchMedia') as
    | ((query: string) => MediaQueryList)
    | undefined;
  const standalone =
    matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const iosPwa = /iPhone|iPad|iPod/.test(navigator.userAgent) && standalone;
  if (iosPwa) workerUrl.searchParams.set('event-cache', 'memory');

  return new SharedWorker(workerUrl, {
    type: 'module',
    name: generation === 0 ? 'sable-core' : `sable-core-${String(generation)}`,
  });
}

export function prewarmWebWorker(): void {
  if (prewarmed || typeof SharedWorker === 'undefined') return;
  const generation = readGeneration();
  const entry: PrewarmedWorker = { worker: openWorker(generation), generation, failure: null };
  on(entry.worker, 'error', (event) => {
    entry.failure ??= (event as ErrorEvent).message || 'unknown error';
  });
  prewarmed = entry;
}

export interface CoreConnection {
  port: MessagePort;
  onFailure(handler: (message: string) => void): void;
  retire(): void;
  /** Electron's `MessagePortMain` silently drops messages that transfer an `ArrayBuffer`. */
  copiesBuffers?: true;
}

/** `adopt` takes the worker `prewarmWebWorker` opened, which only the core's transport should. */
export function openSharedWorker(adopt = true): CoreConnection {
  const adopted = adopt ? prewarmed : null;
  if (adopt) prewarmed = null;
  const generation = adopted?.generation ?? readGeneration();
  const worker = adopted?.worker ?? openWorker(generation);

  return {
    port: worker.port,
    onFailure(handler) {
      // Only the worker failing to load reaches here. Runtime failures inside it
      // are reported to its own global scope, so the worker forwards those itself.
      on(worker, 'error', (event) => {
        const { message } = event as ErrorEvent;
        handler(`shared worker failed to start: ${message || 'unknown error'}`);
      });
      if (adopted?.failure) {
        const failure = adopted.failure;
        queueMicrotask(() => {
          handler(`shared worker failed to start: ${failure}`);
        });
      }
    },
    retire() {
      retireGeneration(generation);
    },
  };
}

export function createWebTransport(open: () => CoreConnection = openSharedWorker): Transport {
  const listeners = new Set<(event: CoreEvent) => void>();
  // Which reply belongs to which id is a runtime fact, so it cannot be typed.
  type Reply = unknown;
  const pending = new Map<
    number,
    { resolve: (value: Reply) => void; reject: (error: unknown) => void }
  >();
  const pendingCommands = new Map<number, string>();
  const crashListeners = new Set<(message: string) => void>();
  const storageFailureListeners = new Set<() => void>();
  const supersededListeners = new Set<() => void>();
  const stallListeners = new Set<(stalled: boolean) => void>();
  const overdue = new Set<number>();
  let healthProbeTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  let nextId = 1;
  let worker: CoreConnection | null = null;
  let debugLogs = false;
  let closed = false;

  const stallAfterMs = 20_000;
  const healthProbeTimeoutMs = 2_000;
  const healthProbeIntervalMs = 5_000;

  function reportStall(next: boolean): void {
    if (stalled === next) return;
    stalled = next;
    if (next) {
      Sentry.captureMessage('Core worker stopped responding', {
        level: 'error',
        fingerprint: ['wasm-core-stall'],
        tags: { source: 'wasm-core' },
        extra: { pendingRequests: pending.size },
      });
    }
    for (const listener of stallListeners) listener(next);
  }

  function clearHealthProbe(): void {
    if (healthProbeTimer !== undefined) clearTimeout(healthProbeTimer);
    healthProbeTimer = undefined;
  }

  function scheduleHealthProbe(delay = 0): void {
    if (closed || overdue.size === 0 || healthProbeTimer !== undefined) {
      return;
    }
    healthProbeTimer = setTimeout(() => {
      healthProbeTimer = undefined;
      if (closed || overdue.size === 0) return;

      const id = nextId++;
      connect().port.postMessage({ id, ping: true });
      healthProbeTimer = setTimeout(() => {
        healthProbeTimer = undefined;
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

  function markWorkerResponsive(): void {
    if (overdue.size === 0) return;
    clearHealthProbe();
    reportStall(false);
    scheduleHealthProbe(healthProbeIntervalMs);
  }

  function rejectPending(logId: string): void {
    const waiting = [...pending.values()];
    pending.clear();
    pendingCommands.clear();
    for (const { reject } of waiting) {
      reject(new CoreError({ code: 'failed', log_id: logId }));
    }
  }

  function handleCrash(message: string, stack?: string): void {
    // A Rust panic crosses as a string and carries this file's stack; a worker
    // JS failure brings its own. The fingerprint groups on the message.
    const error = new Error(message);
    if (stack) error.stack = stack;
    Sentry.captureException(error, {
      fingerprint: ['wasm-core-crash', message],
      tags: { source: 'wasm-core' },
    });
    console.error('[sable transport] core panicked', error);
    worker?.retire();
    worker?.port.close();
    worker = null;
    clearHealthProbe();
    overdue.clear();
    reportStall(false);
    rejectPending(`core panicked: ${message}`);
    for (const listener of crashListeners) listener(message);
  }

  function handleSuperseded(): void {
    // Reconnecting would claim the store back from the newer worker.
    closed = true;
    worker?.port.close();
    worker = null;
    clearHealthProbe();
    overdue.clear();
    reportStall(false);
    rejectPending('core superseded by a newer tab');
    for (const listener of supersededListeners) listener();
  }

  function connect(): CoreConnection {
    if (worker) return worker;

    const nextWorker = open();
    nextWorker.onFailure((message) => {
      if (worker === nextWorker) handleCrash(message);
    });

    nextWorker.port.onmessageerror = () => {
      handleCrash('worker message could not be decoded');
    };

    nextWorker.port.onmessage = (message: MessageEvent<WorkerMessage>) => {
      const data = message.data;
      markWorkerResponsive();

      if ('events' in data) {
        for (const event of data.events) {
          for (const listener of listeners) listener(event);
        }
        return;
      }

      if ('logs' in data) {
        for (const line of data.logs) {
          const level = wasmLogLevel(line);
          recordDebugLog(level, level === 'error' ? 'error' : 'general', 'wasm', line.trim());
          if (line.includes('session tokens:')) {
            Sentry.addBreadcrumb({ category: 'core.session', level: 'info', message: line.trim() });
          }
          if (level === 'error' || isUndecryptableToDevice(line) || isReportableCoreWarning(line)) {
            reportCoreError(line, () => {
              for (const listener of storageFailureListeners) listener();
            });
          }
        }
        return;
      }

      if ('panic' in data) {
        handleCrash(data.panic.message, data.panic.stack);
        return;
      }

      if ('superseded' in data) {
        handleSuperseded();
        return;
      }

      if ('pong' in data) return;

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
        if (!QUIET_COMMAND_FAILURES.has(`${String(command)}:${data.err.code}`)) {
          console.warn('[sable transport] command failed', { command, ...data.err });
        }
        waiting.reject(new CoreError(data.err));
      }
    };

    nextWorker.port.start();
    if (debugLogs) nextWorker.port.postMessage({ debugLogs: true });
    if (typeof document !== 'undefined') {
      nextWorker.port.postMessage({
        visible: document.visibilityState === 'visible',
      } satisfies WorkerRequest);
    }
    const logFilter = new URLSearchParams(self.location.search).get('log') ?? storedLogFilter();
    if (logFilter) nextWorker.port.postMessage({ logFilter });
    worker = nextWorker;
    return nextWorker;
  }

  const releasePageHide =
    typeof window === 'undefined'
      ? undefined
      : on(window, 'pagehide', (event) => {
          if (event.persisted) return;
          worker?.port.postMessage({ disconnect: true } satisfies WorkerRequest);
        });

  const releaseVisibility =
    typeof document === 'undefined'
      ? undefined
      : on(document, 'visibilitychange', () => {
          worker?.port.postMessage({
            visible: document.visibilityState === 'visible',
          } satisfies WorkerRequest);
        });

  function detach(reason: string, farewell: WorkerRequest): void {
    closed = true;
    releasePageHide?.();
    releaseVisibility?.();
    listeners.clear();
    crashListeners.clear();
    supersededListeners.clear();
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
      const migration = migrateV1();
      if (migration) await migration;
      if (closed) throw new CoreError({ code: 'failed', log_id: 'transport closed' });
      const id = nextId++;
      const activeWorker = connect();

      return new Promise<T>((resolve, reject) => {
        const request = body(id);
        const label = requestLabel(request);
        if (label !== undefined) recordDebugLog('debug', 'network', 'transport', label);
        const timeout =
          label === 'auth.login_flows'
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
          'call' in request
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
        activeWorker.port.postMessage(request, activeWorker.copiesBuffers ? [] : transfers);
      });
    })();
  }

  return {
    call(method, params) {
      return request<unknown>((id) => ({ id, call: { method, params } }));
    },

    fetchMedia(source, width, height, background = false) {
      return request<Uint8Array<ArrayBuffer>>((id) => ({
        id,
        media: { source, width, height, background },
      }));
    },

    async forgetMedia(source) {
      await request<null>((id) => ({ id, forget: { source } }));
    },

    async sendAttachment({
      roomId,
      filename,
      mime,
      bytes,
      caption,
      formattedCaption,
      mentions,
      mentionsRoom,
      inReplyTo,
      silentReply,
      info,
      threadRoot,
      persona,
      spoiler,
    }) {
      await request<null>(
        (id) => ({
          id,
          attachment: {
            roomId,
            filename,
            mime,
            bytes,
            caption: caption ?? null,
            formattedCaption: formattedCaption ?? null,
            mentions: mentions ?? [],
            mentionsRoom: mentionsRoom ?? false,
            inReplyTo: inReplyTo ?? null,
            silentReply: silentReply ?? false,
            info: info ?? null,
            threadRoot: threadRoot ?? null,
            persona: persona ?? null,
            spoiler: spoiler ?? false,
          },
        }),
        [bytes.buffer]
      );
    },

    async sendGallery({
      roomId,
      attachments,
      caption,
      formattedCaption,
      mentions,
      mentionsRoom,
      inReplyTo,
      silentReply,
      threadRoot,
      persona,
    }) {
      const transfer = attachments.map((attachment) => attachment.bytes.buffer);
      await request<null>(
        (id) => ({
          id,
          gallery: {
            roomId,
            attachments,
            caption: caption ?? null,
            formattedCaption: formattedCaption ?? null,
            mentions: mentions ?? [],
            mentionsRoom: mentionsRoom ?? false,
            inReplyTo: inReplyTo ?? null,
            silentReply: silentReply ?? false,
            threadRoot: threadRoot ?? null,
            persona: persona ?? null,
          },
        }),
        transfer
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

    subscribeStorageFailure(onStorageFailure) {
      storageFailureListeners.add(onStorageFailure);
      return () => storageFailureListeners.delete(onStorageFailure);
    },

    subscribeSuperseded(onSuperseded) {
      supersededListeners.add(onSuperseded);
      return () => supersededListeners.delete(onSuperseded);
    },

    subscribeStall(onStall) {
      stallListeners.add(onStall);
      return () => stallListeners.delete(onStall);
    },

    async resetCaches(accountIds) {
      await request<null>((id) => ({ id, reset: true }));
      detach('cache reset', { disconnect: true });

      try {
        await resetWebStorage(accountIds);
      } catch (error) {
        Sentry.captureException(error, { tags: { source: 'cache-reset' } });
        console.error('[sable transport] the local caches were not fully cleared', error);
      }
    },

    async deleteAccountStore(accountId) {
      await deleteAccountWebStorage(accountId);
    },

    close() {
      detach('transport closed', { disconnect: true });
    },
  };
}
