import type { Command } from '@/generated/Command';
import type { CommandOk } from '@/generated/CommandOk';
import type { CommandErr } from '@/generated/CommandErr';
import type { CoreEvent } from '@/generated/CoreEvent';

/** Resolves a command's response from its tag, so `send` is typed end to end. */
export type ResponseFor<T extends Command['type']> = Extract<CommandOk, { type: T }>;

export type Attachment = {
  roomId: string;
  filename: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
  caption?: string | null;
  inReplyTo?: string | null;
};

export class CoreError extends Error {
  constructor(readonly detail: CommandErr) {
    super(detail.code);
  }
}

export interface Transport {
  send<C extends Command>(command: C): Promise<ResponseFor<C['type']>>;

  /** Thumbnail bytes for an `mxc://` URI. */
  fetchMedia(source: string, width: number, height: number): Promise<Uint8Array<ArrayBuffer>>;

  /**
   * Resolves once the event is queued, not once the upload finishes. Progress
   * and failure arrive as `send_state` on the local echo.
   */
  sendAttachment(attachment: Attachment): Promise<void>;

  /** Resolves with the `mxc:` URI, which the avatar commands take. */
  uploadMedia(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;

  subscribe(onEvent: (event: CoreEvent) => void): () => void;
  close(): void;
}

/** Applies a batch of diffs to a local array. The only Matrix state the UI owns. */
export function applyDiffs<T>(current: readonly T[], diffs: readonly Diff<T>[]): T[] {
  let next = [...current];
  for (const diff of diffs) {
    switch (diff.op) {
      case 'append':
        next = [...next, ...diff.values];
        break;
      case 'clear':
        next = [];
        break;
      case 'push_front':
        next = [diff.value, ...next];
        break;
      case 'push_back':
        next = [...next, diff.value];
        break;
      case 'pop_front':
        next = next.slice(1);
        break;
      case 'pop_back':
        next = next.slice(0, -1);
        break;
      case 'insert':
        next = [...next.slice(0, diff.index), diff.value, ...next.slice(diff.index)];
        break;
      case 'set':
        next = [...next.slice(0, diff.index), diff.value, ...next.slice(diff.index + 1)];
        break;
      case 'remove':
        next = [...next.slice(0, diff.index), ...next.slice(diff.index + 1)];
        break;
      case 'truncate':
        next = next.slice(0, diff.length);
        break;
      case 'reset':
        next = [...diff.values];
        break;
    }
  }
  return next;
}

type Diff<T> =
  | { op: 'append'; values: T[] }
  | { op: 'clear' }
  | { op: 'push_front'; value: T }
  | { op: 'push_back'; value: T }
  | { op: 'pop_front' }
  | { op: 'pop_back' }
  | { op: 'insert'; index: number; value: T }
  | { op: 'set'; index: number; value: T }
  | { op: 'remove'; index: number }
  | { op: 'truncate'; length: number }
  | { op: 'reset'; values: T[] };
