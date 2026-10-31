import type { MessagePortMain } from 'electron';

import {
  createCoreWorkerBoundary,
  type WorkerCore,
  type WorkerPort,
} from '../../src/worker/core-worker-boundary.ts';
import type { WorkerRequest } from '../../src/worker/protocol.ts';

interface NativeCore {
  restore(): Promise<void>;
  setActive(active: boolean): Promise<void>;
  call(method: string, params: string): Promise<string>;
  fetchMedia(source: string, width: number, height: number, background: boolean): Promise<Buffer>;
  forgetMedia(source: string): Promise<void>;
  sendAttachment(request: string, bytes: Uint8Array): Promise<void>;
  sendGallery(request: string, bytes: Uint8Array): Promise<void>;
  uploadMedia(mime: string, bytes: Uint8Array): Promise<string>;
  subscribeEvents(onEvents: (json: string) => void): void;
}

interface NativeModule {
  SableCore: new (dataDir: string, logFilter: string | null) => NativeCore;
  setLogHandler(notify: (line: string) => void): void;
  setLogCapture(enabled: boolean): void;
  installKeyring(service: string): void;
}

const EVENT_BACKLOG_LIMIT = 4096;

const dataDir = process.env.SABLE_DATA_DIR;
if (!dataDir) throw new Error('SABLE_DATA_DIR is not set');
const identifier = process.env.SABLE_IDENTIFIER;
if (!identifier) throw new Error('SABLE_IDENTIFIER is not set');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require('./sable_node.node') as NativeModule;
try {
  native.installKeyring(identifier);
} catch (error) {
  process.parentPort.postMessage({
    keyringUnavailable: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
const instance = new native.SableCore(dataDir, process.env.SABLE_LOG ?? null);
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
  }
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

process.parentPort.on('message', (event) => {
  if (event.ports.length !== 1) return;
  const [port] = event.ports;
  boundary.connect(wrap(port));

  const queued = backlog;
  backlog = null;
  for (const json of queued ?? []) boundary.handleEvent(json);
});
