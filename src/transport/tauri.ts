import { attachmentBytes } from './attachment-bytes';
import * as Sentry from '@sentry/sveltekit';
import { Channel, invoke } from '@tauri-apps/api/core';

import type { RpcError, CoreEvent } from '#src/generated/protocol';
import { CoreError, type Transport } from './index';
import { recordDebugLog } from '#lib/observability/debug-log.svelte.js';
import { wasmLogLevel } from '#lib/observability/wasm-log.js';
import { rawInvoke } from '#lib/platform/raw-invoke.js';
import { resetWebStorage } from '#lib/platform/session-storage.js';

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

  const logs = new Channel<string[]>();
  logs.onmessage = (lines) => {
    for (const line of lines) {
      const level = wasmLogLevel(line);
      recordDebugLog(level, level === 'error' ? 'error' : 'general', 'core', line.trim());
    }
  };

  return {
    async call(method, params) {
      await ready;
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
      thumbnail,
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
      await carry('send_attachment', attachmentBytes([{ bytes, thumbnail }]), {
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
      await carry('send_gallery', attachmentBytes(gallery.attachments), {
        request: JSON.stringify({
          room_id: gallery.roomId,
          attachments: gallery.attachments.map(
            ({ filename, mime, info = null, spoiler = false }) => ({
              filename,
              mime,
              info,
              spoiler,
            })
          ),
          caption: gallery.caption ?? null,
          formatted_caption: gallery.formattedCaption ?? null,
          mentions: gallery.mentions ?? [],
          mentions_room: gallery.mentionsRoom ?? false,
          in_reply_to: gallery.inReplyTo ?? null,
          silent_reply: gallery.silentReply ?? false,
          thread_root: gallery.threadRoot ?? null,
          persona: gallery.persona ?? null,
        }),
      });
    },

    uploadMedia(mime, bytes) {
      return carry<string>('upload_media', bytes, { mime });
    },

    async rtcData(sessionId, frame) {
      return new Uint8Array(await carry<ArrayBuffer>('rtc_data', frame, { session: sessionId }));
    },

    setDebugLogs(enabled) {
      invoke('set_debug_logs', { enabled, channel: logs }).catch((error: unknown) => {
        console.warn('[sable transport] core log capture unavailable', error);
      });
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
