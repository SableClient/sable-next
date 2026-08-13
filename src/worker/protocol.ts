import type { Command } from '@/generated/Command';
import type { CommandErr } from '@/generated/CommandErr';
import type { CommandOk } from '@/generated/CommandOk';
import type { CoreEvent } from '@/generated/CoreEvent';

export type AttachmentRequest = {
  roomId: string;
  filename: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
  caption: string | null;
  inReplyTo: string | null;
};

/** Page → worker. `id` correlates the reply; the worker never reorders. */
export type WorkerRequest =
  | { id: number; command: Command }
  | { disconnect: true }
  | { id: number; media: { source: string; width: number; height: number } }
  | { id: number; attachment: AttachmentRequest }
  | { id: number; upload: { mime: string; bytes: Uint8Array<ArrayBuffer> } };

/** Worker → page. Events carry no id because they answer nothing. */
export type WorkerMessage =
  | { id: number; ok: CommandOk }
  | { id: number; err: CommandErr }
  // Transferred, not copied, so a thumbnail crosses once.
  | { id: number; bytes: Uint8Array<ArrayBuffer> }
  /** An `mxc:` URI from `uploadMedia`, or nothing from `sendAttachment`. */
  | { id: number; uri: string | null }
  | { event: CoreEvent };
