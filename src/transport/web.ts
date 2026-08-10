import type { Command } from '@/generated/Command';
import type { CommandOk } from '@/generated/CommandOk';
import type { CoreEvent } from '@/generated/CoreEvent';
import type { WorkerMessage, WorkerRequest } from '@/worker/protocol';
import { CoreError, type ResponseFor, type Transport } from './index';

export function createWebTransport(): Transport {
  const worker = new SharedWorker(new URL('../worker/core.worker.ts', import.meta.url), {
    type: 'module',
    name: 'sable-core',
  });

  const listeners = new Set<(event: CoreEvent) => void>();
  // Which reply belongs to which id is a runtime fact, so it cannot be typed.
  type Reply = CommandOk | Uint8Array<ArrayBuffer> | string | null;
  const pending = new Map<
    number,
    { resolve: (value: Reply) => void; reject: (error: unknown) => void }
  >();
  let nextId = 1;

  worker.port.onmessage = (message: MessageEvent<WorkerMessage>) => {
    const data = message.data;

    if ('event' in data) {
      for (const listener of listeners) listener(data.event);
      return;
    }

    const waiting = pending.get(data.id);
    if (!waiting) return;
    pending.delete(data.id);

    if ('ok' in data) waiting.resolve(data.ok);
    else if ('bytes' in data) waiting.resolve(data.bytes);
    else if ('uri' in data) waiting.resolve(data.uri);
    else waiting.reject(new CoreError(data.err));
  };

  worker.port.start();

  function request<T extends Reply>(
    body: (id: number) => WorkerRequest,
    transfers: Transferable[] = []
  ): Promise<T> {
    const id = nextId++;

    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: Reply) => void, reject });
      worker.port.postMessage(body(id), transfers);
    });
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

    async sendAttachment({ roomId, filename, mime, bytes, caption, inReplyTo }) {
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

    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },

    close() {
      listeners.clear();
      // The worker outlives the tab: others may be using it, and it is what
      // keeps sync running.
      worker.port.close();
    },
  };
}
