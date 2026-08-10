/// <reference lib="webworker" />

import init, { SableCore } from '@/generated/wasm/sable_core.js';
import { clearSession, loadSession, saveSession } from '@/platform/sessionStorage';
import type { WorkerMessage, WorkerRequest } from './protocol';

declare const self: SharedWorkerGlobalScope;

// One core per origin: every tab shares this sync loop and store.
const ports = new Set<MessagePort>();

const core = init().then(() => {
  const instance = new SableCore(
    'sable-next',
    () => loadSession(),
    (bytes: Uint8Array) => saveSession(bytes),
    () => clearSession(),
    // `?log=` in the page URL raises it, e.g. `?log=info,matrix_sdk::http_client=debug`
    // to see every request the SDK makes.
    new URLSearchParams(self.location.search).get('log') ?? 'info'
  );

  instance.subscribeEvents((json: string) => {
    broadcast({ event: JSON.parse(json) });
  });

  return instance;
});

function broadcast(message: WorkerMessage) {
  for (const port of ports) port.postMessage(message);
}

self.onconnect = (connect: MessageEvent) => {
  const port = connect.ports[0];
  ports.add(port);

  port.onmessage = async (message: MessageEvent<WorkerRequest>) => {
    const request = message.data;
    const { id } = request;

    try {
      const instance = await core;

      if ('media' in request) {
        const { source, width, height } = request.media;
        // wasm-bindgen copies into a fresh, unshared ArrayBuffer but types it
        // only as `ArrayBufferLike`.
        const bytes = (await instance.fetchMedia(source, width, height)) as Uint8Array<ArrayBuffer>;
        // Transferred: the worker has no use for it after.
        port.postMessage({ id, bytes } satisfies WorkerMessage, [bytes.buffer]);
        return;
      }

      if ('attachment' in request) {
        const { roomId, filename, mime, bytes, caption, inReplyTo } = request.attachment;
        await instance.sendAttachment(roomId, filename, mime, bytes, caption, inReplyTo);
        port.postMessage({ id, uri: null } satisfies WorkerMessage);
        return;
      }

      if ('upload' in request) {
        const { mime, bytes } = request.upload;
        const uri = await instance.uploadMedia(mime, bytes);
        port.postMessage({ id, uri } satisfies WorkerMessage);
        return;
      }

      const ok = await instance.submitCommand(JSON.stringify(request.command));
      port.postMessage({ id, ok: JSON.parse(ok) } satisfies WorkerMessage);
    } catch (cause) {
      // The core rejects with the JSON of `CommandErr`. Anything else is a
      // carrier bug, reported as `failed` instead of swallowed.
      const err =
        typeof cause === 'string'
          ? JSON.parse(cause)
          : { code: 'failed' as const, log_id: String(cause) };

      port.postMessage({ id, err } satisfies WorkerMessage);
    }
  };

  port.start();
};
