import type { RpcError, CoreEvent } from '#src/generated/protocol';
import type { Attachment, Gallery, GalleryAttachment } from '#src/transport';

export interface WasmDebugImage {
  type: 'wasm';
  code_file: string;
  code_id: string;
  debug_id: string;
}

export type AttachmentRequest = Required<Omit<Attachment, 'thumbnail'>> &
  Pick<Attachment, 'thumbnail'>;
export type GalleryRequest = Required<Omit<Gallery, 'attachments'>> & {
  attachments: GalleryAttachment[];
};

export type WorkerRequest =
  | { id: number; call: { method: string; params: unknown } }
  | { id: number; ping: true }
  | { disconnect: true }
  | { id: number; reset: true }
  | { debugLogs: boolean }
  | { visible: boolean }
  | { logFilter: string }
  | { id: number; media: { source: string; width: number; height: number; background?: boolean } }
  | { id: number; forget: { source: string } }
  | { id: number; attachment: AttachmentRequest }
  | { id: number; gallery: GalleryRequest }
  | { id: number; upload: { mime: string; bytes: Uint8Array<ArrayBuffer> } }
  | { id: number; rtc: { sessionId: string; frame: Uint8Array<ArrayBuffer> } };

/** Worker → page. Events carry no id because they answer nothing. */
export type WorkerMessage =
  | { id: number; ok: unknown }
  | { id: number; pong: true }
  | { id: number; err: RpcError }
  // Transferred so a thumbnail crosses once.
  | { id: number; bytes: Uint8Array<ArrayBuffer> }
  /** An `mxc:` URI from `uploadMedia`, or nothing from `sendAttachment` and `forgetMedia`. */
  | { id: number; uri: string | null }
  | { events: CoreEvent[] }
  | { logs: string[] }
  | { span: { name: string; startMs: number; durationMs: number } }
  | { panic: { message: string; stack?: string; wasm?: WasmDebugImage } }
  | { superseded: true };
