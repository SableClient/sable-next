import { Channel, invoke } from '@tauri-apps/api/core';

import type { Command } from '#src/generated/Command';
import type { CommandErr } from '#src/generated/CommandErr';
import type { CoreEvent } from '#src/generated/CoreEvent';
import { CoreError, type ResponseFor, type Transport } from './index';

/**
 * A `Vec<u8>` argument would be marshalled as a JSON array of numbers, so the
 * bytes ride the raw request body and the metadata the headers.
 */
async function rawInvoke<T>(
  command: string,
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>
): Promise<T> {
  try {
    return await invoke<T>(command, bytes, { headers });
  } catch (error) {
    throw new CoreError(error as CommandErr);
  }
}

/**
 * The core runs in the Tauri process, so there is no serialisation boundary to
 * design: `invoke` is the command channel and `Channel` the event one.
 */
export function createTauriTransport(): Transport {
  const listeners = new Set<(event: CoreEvent) => void>();

  const channel = new Channel<CoreEvent[]>();
  channel.onmessage = (events) => {
    for (const event of events) {
      for (const listener of listeners) listener(event);
    }
  };

  const ready = invoke<unknown>('subscribe_events', { channel });

  return {
    async send<C extends Command>(command: C) {
      await ready;
      try {
        return await invoke<ResponseFor<C['type']>>('submit_command', { command });
      } catch (error) {
        throw new CoreError(error as CommandErr);
      }
    },

    async fetchMedia(source, width, height) {
      try {
        // `Response` on the Rust side makes this an ArrayBuffer rather than JSON.
        const bytes = await invoke<ArrayBuffer>('fetch_media', { source, width, height });
        return new Uint8Array(bytes);
      } catch (error) {
        throw new CoreError(error as CommandErr);
      }
    },

    async sendAttachment({ roomId, filename, mime, bytes, caption, inReplyTo, info, threadRoot }) {
      await rawInvoke('send_attachment', bytes, {
        'room-id': roomId,
        filename,
        mime,
        ...(caption ? { caption } : {}),
        ...(inReplyTo ? { 'in-reply-to': inReplyTo } : {}),
        ...(info ? { info: JSON.stringify(info) } : {}),
        ...(threadRoot ? { 'thread-root': threadRoot } : {}),
      });
    },

    uploadMedia(mime, bytes) {
      return rawInvoke<string>('upload_media', bytes, { mime });
    },

    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },

    subscribeCrash() {
      return () => {};
    },

    subscribeStall() {
      return () => {};
    },

    close() {
      listeners.clear();
    },
  };
}
