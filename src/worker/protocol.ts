import type { AttachmentInfoView } from '#src/generated/AttachmentInfoView';
import type { Command } from '#src/generated/Command';
import type { CommandErr } from '#src/generated/CommandErr';
import type { CommandOk } from '#src/generated/CommandOk';
import type { CoreEvent } from '#src/generated/CoreEvent';

export type AttachmentRequest = {
  roomId: string;
  filename: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
  caption: string | null;
  inReplyTo: string | null;
  info: AttachmentInfoView | null;
  threadRoot: string | null;
};

export type WorkerRequest =
  | { id: number; command: Command }
  | { id: number; ping: true }
  | { disconnect: true }
  | { id: number; reset: true }
  | { debugLogs: boolean }
  | { id: number; media: { source: string; width: number; height: number } }
  | { id: number; attachment: AttachmentRequest }
  | { id: number; upload: { mime: string; bytes: Uint8Array<ArrayBuffer> } };

/** Worker → page. Events carry no id because they answer nothing. */
export type WorkerMessage =
  | { id: number; ok: CommandOk }
  | { id: number; pong: true }
  | { id: number; err: CommandErr }
  // Transferred, not copied, so a thumbnail crosses once.
  | { id: number; bytes: Uint8Array<ArrayBuffer> }
  /** An `mxc:` URI from `uploadMedia`, or nothing from `sendAttachment`. */
  | { id: number; uri: string | null }
  | { event: CoreEvent }
  | { logs: string[] }
  | { panic: { message: string } };
