import type {
  AttachmentInfoView,
  ErrorReportView,
  RpcError,
  CoreEvent,
  PerMessageProfileView,
} from '#src/generated/protocol';

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
  'filename' | 'mime' | 'bytes' | 'info' | 'thumbnail' | 'spoiler'
>;

function describe(detail: RpcError): string {
  const { code, report, ...fields } = detail;
  const chain = (report?.frames ?? []).map((frame) => frame.message).join(': ');
  if (detail.code === 'failed') {
    return chain ? `failed [${detail.log_id}] ${chain}` : `failed: ${detail.log_id}`;
  }
  const head = Object.keys(fields).length > 0 ? `${code} ${JSON.stringify(fields)}` : code;
  return chain ? `${head}: ${chain}` : head;
}

export class CoreError extends Error {
  name = 'CoreError';

  constructor(
    readonly detail: RpcError,
    readonly method?: string
  ) {
    super(method ? `${method}: ${describe(detail)}` : describe(detail));
  }

  get report(): ErrorReportView | null {
    return this.detail.report ?? null;
  }
}

/**
 * Sentry turns `console.error` and `console.warn` into events, and the core
 * already reports a failure, so the report goes out on levels it leaves alone.
 */
function logReport(error: CoreError, report: ErrorReportView): void {
  console.groupCollapsed(`[sable core] ${error.message}`);
  for (const [depth, frame] of report.frames.entries()) {
    const where = frame.location ? ` at ${frame.location}` : '';
    console.log(`${'  '.repeat(depth)}${frame.message}${where}`);
    if (frame.debug) console.log(frame.debug);
  }
  if (report.http) console.log('http', report.http);
  if (report.span_trace) console.log(`spans\n${report.span_trace}`);
  console.groupEnd();
}

export function commandFailed(detail: RpcError, method: string | undefined): CoreError {
  const error = new CoreError(detail, method);
  if (error.report) logReport(error, error.report);
  else console.info(`[sable core] ${error.message}`, detail);
  return error;
}

export function transportFailure(reason: string): RpcError {
  return { code: 'failed', log_id: reason, report: null };
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

  /** Resolves with the bytes to send back on the data channel, empty when there are none. */
  rtcData(sessionId: string, frame: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;

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

/** Applies a batch of diffs to a local array. The only Matrix state the UI owns. */
export function applyDiffs<T>(current: readonly T[], diffs: readonly Diff<T>[]): T[] {
  const next = [...current];
  for (const diff of diffs) {
    switch (diff.op) {
      case 'append':
        next.push(...diff.values);
        break;
      case 'clear':
        next.length = 0;
        break;
      case 'push_front':
        next.unshift(diff.value);
        break;
      case 'push_back':
        next.push(diff.value);
        break;
      case 'pop_front':
        next.shift();
        break;
      case 'pop_back':
        next.pop();
        break;
      case 'insert':
        next.splice(diff.index, 0, diff.value);
        break;
      case 'set':
        next[diff.index] = diff.value;
        break;
      case 'remove':
        next.splice(diff.index, 1);
        break;
      case 'truncate':
        next.length = diff.length;
        break;
      case 'reset':
        next.splice(0, next.length, ...diff.values);
        break;
    }
  }
  return next;
}

type Diff<T> =
  | { op: 'append'; values: readonly T[] }
  | { op: 'clear' }
  | { op: 'push_front'; value: T }
  | { op: 'push_back'; value: T }
  | { op: 'pop_front' }
  | { op: 'pop_back' }
  | { op: 'insert'; index: number; value: T }
  | { op: 'set'; index: number; value: T }
  | { op: 'remove'; index: number }
  | { op: 'truncate'; length: number }
  | { op: 'reset'; values: readonly T[] };
