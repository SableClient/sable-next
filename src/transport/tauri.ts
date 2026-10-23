import * as Sentry from '@sentry/sveltekit';
import { Channel, invoke } from '@tauri-apps/api/core';

import type { Batch, RpcError, CoreEvent } from '#src/generated/protocol';
import { CoreError, type Transport } from './index';
import type { Link } from '../lib/runtime/link';
import { rawInvoke } from '#lib/platform/raw-invoke.js';
import { resetWebStorage } from '#lib/platform/session-storage.js';
import { migrateV1 } from '#lib/migrations/v1/migration.js';

async function carry<T>(
  command: string,
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>
): Promise<T> {
  try {
    return await rawInvoke<T>(command, bytes, headers);
  } catch (error) {
    throw new CoreError(error as RpcError);
  }
}

/** The runtime never restarts without the process, so this link has no `onRestart`. */
export function createTauriLink(): Link {
  const batchListeners = new Set<(batch: Batch) => void>();
  const channel = new Channel<Batch>();
  channel.onmessage = (batch) => {
    for (const listener of batchListeners) listener(batch);
  };
  const connected = invoke('runtime_connect', { channel });

  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    await connected;
    try {
      return await invoke<T>(command, args);
    } catch (code) {
      throw new Error(String(code), { cause: code });
    }
  };

  return {
    handshake: () => call('runtime_handshake'),
    subscribe: (request) => call('runtime_subscribe', { request }),
    unsubscribe: (sub) => call('runtime_unsubscribe', { sub }),
    resync: (sub) => call('runtime_resync', { sub }),
    range: (sub, range) => call('runtime_range', { sub, range }),
    dispatch: (target, action) => call('runtime_dispatch', { target, action }),
    request: (target, action) => call('runtime_request', { target, action }),
    onBatch: (listener) => {
      batchListeners.add(listener);
      return () => batchListeners.delete(listener);
    },
  };
}

/**
 * The core runs in the Tauri process: `invoke` carries commands and `Channel` events.
 */
export function createTauriTransport(): Transport {
  const listeners = new Set<(event: CoreEvent) => void>();

  const channel = new Channel<CoreEvent[]>();
  channel.onmessage = (events) => {
    for (const event of events) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          Sentry.captureException(error, {
            tags: { source: 'tauri-event', event: event.type },
          });
          console.error('[sable transport] event listener failed', error, event.type);
        }
      }
    }
  };

  const ready = invoke<unknown>('subscribe_events', { channel });

  return {
    async call(method, params) {
      await ready;
      await migrateV1();
      try {
        return await invoke<unknown>('call', { method, params });
      } catch (error) {
        throw new CoreError(error as RpcError);
      }
    },

    async fetchMedia(source, width, height, background = false) {
      try {
        // `Response` on the Rust side makes this an ArrayBuffer rather than JSON.
        const bytes = await invoke<ArrayBuffer>('fetch_media', {
          source,
          width,
          height,
          background,
        });
        return new Uint8Array(bytes);
      } catch (error) {
        throw new CoreError(error as RpcError);
      }
    },

    async forgetMedia(source) {
      try {
        await invoke('forget_media', { source });
      } catch (error) {
        throw new CoreError(error as RpcError);
      }
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
      await carry('send_attachment', bytes, {
        request: JSON.stringify({
          room_id: roomId,
          filename,
          mime,
          caption: caption ?? null,
          formatted_caption: formattedCaption ?? null,
          mentions: mentions ?? [],
          mentions_room: mentionsRoom ?? false,
          in_reply_to: inReplyTo ?? null,
          silent_reply: silentReply ?? false,
          info: info ?? null,
          thread_root: threadRoot ?? null,
          persona: persona ?? null,
          spoiler: spoiler ?? false,
        }),
      });
    },

    async sendGallery(gallery) {
      try {
        await invoke('send_gallery', {
          request: {
            room_id: gallery.roomId,
            attachments: gallery.attachments.map(({ filename, mime, info = null }) => ({
              filename,
              mime,
              info,
            })),
            caption: gallery.caption ?? null,
            formatted_caption: gallery.formattedCaption ?? null,
            mentions: gallery.mentions ?? [],
            mentions_room: gallery.mentionsRoom ?? false,
            in_reply_to: gallery.inReplyTo ?? null,
            silent_reply: gallery.silentReply ?? false,
            thread_root: gallery.threadRoot ?? null,
            persona: gallery.persona ?? null,
          },
          items: gallery.attachments.map((attachment) => ({
            ...attachment,
            bytes: Array.from(attachment.bytes),
          })),
        });
      } catch (error) {
        throw new CoreError(error as RpcError);
      }
    },

    uploadMedia(mime, bytes) {
      return carry<string>('upload_media', bytes, { mime });
    },

    setDebugLogs() {},

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

    async resetCaches(accountIds) {
      await ready;
      try {
        await invoke('call', { method: 'session.reset_local_cache', params: {} });
        await resetWebStorage(accountIds);
      } catch (error) {
        Sentry.captureException(error, { tags: { source: 'cache-reset' } });
        console.error('[sable transport] the local caches were not fully cleared', error);
      }
    },

    deleteAccountStore() {
      return Promise.resolve();
    },

    close() {
      listeners.clear();
    },
  };
}
