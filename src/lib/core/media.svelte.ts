import {
  type AttachmentInfoView,
  type PerMessageProfileView,
  createRpc,
} from '#src/generated/protocol';
import { measureAttachment } from './attachment-info';
import { playsAsGif } from '#lib/model/model.js';
import { animatedImage } from '#lib/ui/media-url.js';
import { withResolvedMime } from '#lib/platform/files.js';
import { formatByteSize } from '#lib/ui/byte-size.js';
import { CoreError, type Transport } from '../../transport';
import type { OutgoingMentions } from './api/messages.svelte.js';

export type SendAttachmentOptions = {
  caption?: string | null;
  formattedCaption?: string | null;
  mentions?: OutgoingMentions;
  inReplyTo?: string | null;
  silentReply?: boolean;
  threadRoot?: string | null;
  persona?: PerMessageProfileView | null;
  spoiler?: boolean;
  /** Unset lets the core decide from the file. */
  gif?: boolean;
};

export type SendGalleryOptions = Omit<SendAttachmentOptions, 'spoiler' | 'gif'> & {
  spoilers?: readonly boolean[];
  gifs?: readonly (boolean | undefined)[];
};

const UNMEASURED: AttachmentInfoView = {
  width: null,
  height: null,
  duration_ms: null,
  animated: null,
  blurhash: null,
  waveform: null,
  voice: false,
  audio_metadata: null,
  gif: null,
};

function withGif(info: AttachmentInfoView | null, gif: boolean | undefined) {
  return gif === undefined ? info : { ...(info ?? UNMEASURED), gif };
}

/** Moves bytes: uploads, attachments and media reads, which the RPC router does not carry. */
export function createMedia(transport: () => Transport) {
  const rpc = createRpc((method, params) => transport().call(method, params));

  async function validateAttachments(files: readonly File[]): Promise<void> {
    const upload_size = await rpc.messages.mediaConfig().then((config) => config.upload_size);
    if (files.some((file) => file.size > upload_size)) {
      throw new Error(`Attachment exceeds the ${formatByteSize(upload_size)} limit`);
    }
  }

  return {
    async scheduleAttachment(
      roomId: string,
      picked: File,
      dueTs: number,
      spoiler = false,
      persona: PerMessageProfileView | null = null,
      gif?: boolean
    ): Promise<string> {
      const file = withResolvedMime(picked);
      await validateAttachments([file]);
      const supported = await rpc.session.delayedEventsSupported();
      if (!supported) throw new CoreError({ code: 'delayed_events_unsupported' });
      const [measured, bytes] = await Promise.all([
        measureAttachment(file),
        file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      ]);
      const url = await transport().uploadMedia(file.type || 'application/octet-stream', bytes);
      return rpc.messages.scheduleAttachment({
        room_id: roomId,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        url,
        size: file.size,
        // The core never sees a scheduled file's bytes, so what it decides on sending is decided here.
        info: {
          ...(measured.info ?? UNMEASURED),
          animated: animatedImage(file.type, bytes),
          gif:
            gif ??
            (file.type.startsWith('video/')
              ? playsAsGif(bytes, measured.info?.duration_ms ?? null)
              : null),
        },
        spoiler,
        persona: $state.snapshot(persona),
        delay_ms: Math.max(0, dueTs - Date.now()),
      });
    },

    async sendAttachment(
      roomId: string,
      picked: File,
      options: SendAttachmentOptions = {}
    ): Promise<void> {
      const file = withResolvedMime(picked);
      await validateAttachments([file]);
      const measured = await measureAttachment(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await transport().sendAttachment({
        roomId,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        bytes,
        caption: options.caption ?? null,
        formattedCaption: options.formattedCaption ?? null,
        mentions: [...(options.mentions?.user_ids ?? [])],
        mentionsRoom: options.mentions?.room ?? false,
        inReplyTo: options.inReplyTo ?? null,
        silentReply: options.silentReply ?? false,
        info: withGif(measured.info, options.gif),
        thumbnail: measured.thumbnail,
        threadRoot: options.threadRoot ?? null,
        persona: $state.snapshot(options.persona ?? null),
        spoiler: options.spoiler ?? false,
      });
    },

    async sendGallery(
      roomId: string,
      files: readonly File[],
      options: SendGalleryOptions = {}
    ): Promise<void> {
      if (files.length < 2) throw new Error('A gallery needs at least two attachments');
      await validateAttachments(files);
      const attachments = await Promise.all(
        files.map(withResolvedMime).map(async (file, index) => {
          const measured = await measureAttachment(file);
          return {
            filename: file.name,
            mime: file.type || 'application/octet-stream',
            bytes: new Uint8Array(await file.arrayBuffer()),
            info: withGif(measured.info, options.gifs?.[index]),
            thumbnail: measured.thumbnail,
            spoiler: options.spoilers?.[index] ?? false,
          };
        })
      );
      await transport().sendGallery({
        roomId,
        attachments,
        caption: options.caption ?? null,
        formattedCaption: options.formattedCaption ?? null,
        mentions: [...(options.mentions?.user_ids ?? [])],
        mentionsRoom: options.mentions?.room ?? false,
        inReplyTo: options.inReplyTo ?? null,
        silentReply: options.silentReply ?? false,
        threadRoot: options.threadRoot ?? null,
        persona: $state.snapshot(options.persona ?? null),
      });
    },

    fetchMedia(
      source: string,
      width: number,
      height: number,
      background = false
    ): Promise<Uint8Array<ArrayBuffer>> {
      return transport().fetchMedia(source, width, height, background);
    },

    forgetMedia(source: string): Promise<void> {
      return transport().forgetMedia(source);
    },

    uploadMedia(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
      return transport().uploadMedia(mime, bytes);
    },
  };
}

export type CoreMedia = ReturnType<typeof createMedia>;
