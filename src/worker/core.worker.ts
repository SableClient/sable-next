/// <reference lib="webworker" />

import init, { SableCore, setPanicHandler } from '@/generated/wasm/sable_wasm.js';
import { clearSession, loadSession, saveSession } from '@/platform/sessionStorage';
import { createCoreWorkerBoundary } from './core-worker-boundary';

declare const self: SharedWorkerGlobalScope;

const core = init().then(() => {
  const instance = new SableCore(
    'sable-next',
    () => loadSession(),
    (bytes: Uint8Array) => saveSession(bytes),
    () => clearSession(),
    // The page forwards `?log=` here, e.g. `?log=info,matrix_sdk::http_client=debug`
    // to include the SDK's HTTP diagnostics in this SharedWorker's console.
    new URLSearchParams(self.location.search).get('log') ?? 'info'
  );

  return instance;
});

const boundary = createCoreWorkerBoundary(core);
void core.then((instance) => {
  setPanicHandler((message: string) => {
    boundary.handlePanic(message);
    setTimeout(() => {
      self.close();
    }, 0);
  });
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
