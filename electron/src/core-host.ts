import type { MessagePortMain } from 'electron';

import {
  createCoreWorkerBoundary,
  type WorkerCore,
  type WorkerPort,
} from '../../src/worker/core-worker-boundary.ts';
import { createAppHost, type AppApi, type TabPort } from '../../src/worker/app-host.ts';
import type { AppRequest } from '../../src/worker/app-protocol.ts';
import type { WorkerRequest } from '../../src/worker/protocol.ts';

interface NativeCore {
  restore(): Promise<void>;
  setActive(active: boolean): Promise<void>;
  call(method: string, params: string): Promise<string>;
  fetchMedia(source: string, width: number, height: number, background: boolean): Promise<Buffer>;
  forgetMedia(source: string): Promise<void>;
  sendAttachment(request: string, bytes: Uint8Array): Promise<void>;
  sendGallery(request: string, items: string): Promise<void>;
  uploadMedia(mime: string, bytes: Uint8Array): Promise<string>;
  subscribeEvents(onEvents: (json: string) => void): void;
}

interface NativeModule {
  SableCore: new (dataDir: string, logFilter: string | null) => NativeCore;
  SableApp: new (
    core: NativeCore,
    dataDir: string,
    send: (batch: [tab: number, json: string]) => void
  ) => AppApi & { shutdown(): Promise<void> };
  setLogHandler(notify: (line: string) => void): void;
  setLogCapture(enabled: boolean): void;
}

const EVENT_BACKLOG_LIMIT = 4096;

const dataDir = process.env.SABLE_DATA_DIR;
if (!dataDir) throw new Error('SABLE_DATA_DIR is not set');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require('./sable_node.node') as NativeModule;
const instance = new native.SableCore(dataDir, process.env.SABLE_LOG ?? null);
const app = new native.SableApp(instance, dataDir, ([tab, batch]) => {
  appHost.deliver(tab, batch);
});
void instance.restore();

function unwrap<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    throw new Error(error instanceof Error ? error.message : String(error));
  });
}

const core: WorkerCore = {
  call: (method, params) => unwrap(instance.call(method, params)),
  fetchMedia: (source, width, height, background) =>
    unwrap(instance.fetchMedia(source, width, height, background)),
  forgetMedia: (source) => unwrap(instance.forgetMedia(source)),
  sendAttachment: (request, bytes) => unwrap(instance.sendAttachment(request, bytes)),
  sendGallery: (request, items) => unwrap(instance.sendGallery(request, items)),
  uploadMedia: (mime, bytes) => unwrap(instance.uploadMedia(mime, bytes)),
  setActive: (active) => unwrap(instance.setActive(active)),
};

const boundary = createCoreWorkerBoundary(
  Promise.resolve(core),
  (enabled) => {
    native.setLogCapture(enabled);
  },
  () => {
    process.exit(0);
  },
  undefined,
  () => app.shutdown()
);
native.setLogHandler(boundary.handleLog);

let backlog: string[] | null = [];
let backlogged = 0;
instance.subscribeEvents((json) => {
  if (!backlog) {
    boundary.handleEvent(json);
  } else if (backlogged < EVENT_BACKLOG_LIMIT) {
    backlog.push(json);
    backlogged += (JSON.parse(json) as unknown[]).length;
  }
});

function wrap(port: MessagePortMain): WorkerPort {
  let onmessage: WorkerPort['onmessage'] = null;
  const deliver = (data: WorkerRequest) => {
    void onmessage?.({ data } as MessageEvent<WorkerRequest>);
  };
  port.on('message', (event) => {
    deliver(event.data as WorkerRequest);
  });
  port.on('close', () => {
    deliver({ disconnect: true });
  });

  return {
    postMessage: (message) => {
      port.postMessage(message);
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
    },
    onmessageerror: null,
    start: () => {
      port.start();
    },
  };
}

const closed = new Map<string, Promise<void>>();

const appHost = createAppHost(
  Promise.resolve(app),
  (tab) => closed.get(tab) ?? new Promise(() => {})
);

function wrapTab(port: MessagePortMain): TabPort {
  const portClosed = new Promise<void>((resolve) => port.once('close', resolve));
  let onmessage: TabPort['onmessage'] = null;
  port.on('message', (event) => {
    const data = event.data as AppRequest;
    if (data.op === 'hello') {
      closed.set(data.tab, portClosed);
      void portClosed.then(() => closed.delete(data.tab));
    }
    void onmessage?.({ data } as MessageEvent<AppRequest>);
  });

  return {
    postMessage: (message) => {
      port.postMessage(message);
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
    },
    start: () => {
      port.start();
    },
  };
}

process.parentPort.on('message', (event) => {
  if (event.data === 'stop') {
    // The views are saved as the app stops, which must finish before the process is killed.
    void app.shutdown().finally(() => {
      process.parentPort.postMessage('stopped');
    });
    return;
  }
  if (event.ports.length !== 1) return;
  const [port] = event.ports;
  if (event.data === 'runtime') {
    appHost.attach(wrapTab(port));
    return;
  }
  boundary.connect(wrap(port));

  const queued = backlog;
  backlog = null;
  for (const json of queued ?? []) boundary.handleEvent(json);
});
