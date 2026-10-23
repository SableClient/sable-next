import type {
  AttachmentInfoView,
  RpcError,
  CoreEvent,
  PerMessageProfileView,
} from '#src/generated/protocol';
import type { VectorDiffWire } from '#src/generated/protocol';

export type AttachmentThumbnail = {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
};

export type Attachment = {
  roomId: string;
  filename: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
  thumbnail?: AttachmentThumbnail | null;
  caption?: string | null;
  formattedCaption?: string | null;
  mentions?: string[];
  mentionsRoom?: boolean;
  inReplyTo?: string | null;
  silentReply?: boolean;
  info?: AttachmentInfoView | null;
  threadRoot?: string | null;
  persona?: PerMessageProfileView | null;
  spoiler?: boolean;
};

export type Gallery = {
  roomId: string;
  attachments: GalleryAttachment[];
  caption?: string | null;
  formattedCaption?: string | null;
  mentions?: string[];
  mentionsRoom?: boolean;
  inReplyTo?: string | null;
  silentReply?: boolean;
  threadRoot?: string | null;
  persona?: PerMessageProfileView | null;
};

export type GalleryAttachment = Pick<
  Attachment,
  'filename' | 'mime' | 'bytes' | 'info' | 'thumbnail'
>;

export class CoreError extends Error {
  constructor(readonly detail: RpcError) {
    super(detail.code);
  }
}

export interface Transport {
  /** Runs `"<domain>.<method>"`; typed through `createRpc`. */
  call(method: string, params: unknown): Promise<unknown>;

  /** Thumbnail bytes for an `mxc://` URI. */
  fetchMedia(
    source: string,
    width: number,
    height: number,
    background?: boolean
  ): Promise<Uint8Array<ArrayBuffer>>;

  /** Drops every stored copy of a source, so the next fetch asks the homeserver. */
  forgetMedia(source: string): Promise<void>;

  /**
   * Resolves once the event is queued; progress arrives as `send_state` on the local echo.
   */
  sendAttachment(attachment: Attachment): Promise<void>;

  sendGallery(gallery: Gallery): Promise<void>;

  /** Resolves with the `mxc:` URI, which the avatar commands take. */
  uploadMedia(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;

  setDebugLogs(enabled: boolean): void;

  subscribe(onEvent: (event: CoreEvent) => void): () => void;

  subscribeCrash(onCrash: (message: string) => void): () => void;

  subscribeStorageFailure?(onStorageFailure: () => void): () => void;

  subscribeSuperseded?(onSuperseded: () => void): () => void;

  subscribeStall(onStall: (stalled: boolean) => void): () => void;

  resetCaches(accountIds: readonly string[]): Promise<void>;

  deleteAccountStore(accountId: string): Promise<void>;

  close(): void;
}

/** Applies a batch of typed VectorDiffs to a local array. The only Matrix state the UI owns. */
export function applyDiffs<T>(current: readonly T[], diffs: readonly VectorDiffWire<T>[]): T[] {
  const next = [...current];
  for (const diff of diffs) {
    if ('Clear' in diff) next.length = 0;
    else if ('PopFront' in diff) next.shift();
    else if ('PopBack' in diff) next.pop();
    else if ('Append' in diff && diff.Append) next.push(...diff.Append.values);
    else if ('PushFront' in diff && diff.PushFront) next.unshift(diff.PushFront.value);
    else if ('PushBack' in diff && diff.PushBack) next.push(diff.PushBack.value);
    else if ('Insert' in diff && diff.Insert) next.splice(diff.Insert.index, 0, diff.Insert.value);
    else if ('Set' in diff && diff.Set) next[diff.Set.index] = diff.Set.value;
    else if ('Remove' in diff && diff.Remove) next.splice(diff.Remove.index, 1);
    else if ('Truncate' in diff && diff.Truncate) next.length = diff.Truncate.length;
    else if ('Reset' in diff) next.splice(0, next.length, ...diff.Reset.values);
  }
  return next;
}
