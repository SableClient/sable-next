/// <reference lib="webworker" />

import init, {
  SableCore,
  setLogCapture,
  setLogHandler,
  setPanicHandler,
} from '#src/generated/wasm/sable_wasm.js';
import { clearSession, loadSession, saveSession } from '#lib/platform/session-storage.js';
import { installFirefoxFetchLimit } from './adaptive-fetch';
import { createCoreWorkerBoundary } from './core-worker-boundary';

declare const self: SharedWorkerGlobalScope;

installFirefoxFetchLimit(self);

const core = init().then(() => {
  // Before the constructor, so a panic while opening the session store still
  // carries its Rust message.
  setPanicHandler(crash);

  const instance = new SableCore(
    'sable-next',
    () => loadSession(),
    (bytes: Uint8Array) => saveSession(bytes),
    () => clearSession(),
    new URLSearchParams(self.location.search).get('log'),
    new URLSearchParams(self.location.search).get('event-cache') !== 'memory'
  );

  return instance;
});

const boundary = createCoreWorkerBoundary(
  core,
  (enabled) => {
    void core.then(() => {
      setLogCapture(enabled);
    });
  },
  () => {
    self.close();
  }
);

// A trap unwinds only the call that hit it, so the sync loop and the SDK's
// timers keep re-entering a module whose allocator and borrows were left
// mid-flight. Closing is what stops the derived failures that follow; the next
// page connect builds a fresh worker.
function crash(message: string, stack?: string): void {
  boundary.handlePanic(message, stack);
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
    set onmessage(handler) {
      port.onmessage = handler;
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
