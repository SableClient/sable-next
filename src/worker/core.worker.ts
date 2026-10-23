/// <reference lib="webworker" />

import init, {
  SableApp,
  SableCore,
  setLogCapture,
  setLogFilter,
  setLogHandler,
  setPanicHandler,
} from '#src/generated/wasm/sable_wasm.js';
import { clearSession, loadSession, saveSession } from '#lib/platform/session-storage.js';
import { loadSnapshot, saveSnapshot } from '#lib/platform/snapshot-storage.js';
import { installFirefoxFetchLimit } from './adaptive-fetch';
import { createAppHost } from './app-host';
import { createCoreWorkerBoundary } from './core-worker-boundary';
import { claimStore } from './store-ownership';
import { installUploadDeadline } from './upload-deadline';

declare const self: SharedWorkerGlobalScope;

const SHUTDOWN_LIMIT_MS = 5_000;

installUploadDeadline(self);
installFirefoxFetchLimit(self);

let started: { instance: SableCore; app: SableApp } | null = null;

async function stopCore(): Promise<void> {
  if (!started) return;
  await Promise.race([
    (async () => {
      await started.app.shutdown();
      await started.instance.shutdown();
    })(),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_LIMIT_MS)),
  ]);
}

const created = claimStore(() => {
  boundary.handleSuperseded();
  appHost.handleSuperseded();
  void stopCore().finally(() => {
    self.close();
  });
})
  .then(() => init())
  .then(() => {
    // Before the constructor, so a panic while opening the session store still
    // carries its Rust message.
    setPanicHandler(crash);

    const instance = new SableCore(
      'sable-next',
      () => loadSession(),
      (bytes: Uint8Array) => saveSession(bytes),
      () => clearSession(),
      new URLSearchParams(self.location.search).get('event-cache') !== 'memory'
    );
    const app = new SableApp(
      instance,
      (key: string) => loadSnapshot(key),
      (key: string, value: string) => saveSnapshot(key, value),
      (tab: number, batch: string) => {
        appHost.deliver(tab, batch);
      }
    );
    started = { instance, app };

    return started;
  });

const core = created.then(({ instance }) => instance);
const appHost = createAppHost(created.then(({ app }) => app));

const boundary = createCoreWorkerBoundary(
  core,
  (enabled) => {
    void core.then(() => {
      setLogCapture(enabled);
    });
  },
  () => {
    self.close();
  },
  (filter) => {
    void core.then(() => {
      setLogFilter(filter);
    });
  },
  stopCore
);

// A trap unwinds only its own call, so close the worker rather than keep re-entering a corrupted module; the next connect builds a fresh one.
function crash(message: string, stack?: string): void {
  boundary.handlePanic(message, stack);
  appHost.handlePanic();
  setTimeout(() => {
    self.close();
  }, 0);
}

core.catch((error: unknown) => {
  crash(`core failed to start: ${String(error)}`, errorStack(error));
});

// A SharedWorker's runtime failures never reach the pages that opened it, so
// they ride the same channel as a Rust panic.
self.addEventListener('error', (event) => {
  crash(
    `worker error: ${event.message}`,
    errorStack(event.error) ??
      (event.filename ? `    at ${event.filename}:${event.lineno}:${event.colno}` : undefined)
  );
});
self.addEventListener('online', () => {
  boundary.handleOnline();
});
self.addEventListener('unhandledrejection', (event) => {
  if (!(event.reason instanceof WebAssembly.RuntimeError)) {
    boundary.handleLog(`ERROR unhandled rejection in worker: ${String(event.reason)}`);
    return;
  }
  crash(`unhandled rejection in worker: ${String(event.reason)}`, errorStack(event.reason));
});

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

void core.then((instance) => {
  setLogHandler(boundary.handleLog);
  instance.subscribeEvents(boundary.handleEvent);
});

self.onconnect = (connect: MessageEvent) => {
  const port = connect.ports[0];
  boundary.connect({
    postMessage: (message, transfer) => {
      if (transfer) port.postMessage(message, { transfer });
      else port.postMessage(message);
    },
    get onmessage() {
      return port.onmessage;
    },
    // A tab hands the worker a second port for the runtime, which is not the boundary's.
    set onmessage(handler) {
      port.onmessage =
        handler &&
        ((event: MessageEvent) => {
          if ((event.data as { runtime?: true }).runtime) appHost.attach(event.ports[0]);
          else handler.call(port, event);
        });
    },
    get onmessageerror() {
      return port.onmessageerror;
    },
    set onmessageerror(handler) {
      port.onmessageerror = handler;
    },
    start: () => {
      port.start();
    },
  });
};
