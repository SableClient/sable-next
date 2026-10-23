import type {
  Batch,
  Handshake,
  ReqId,
  Snapshot,
  SubId,
  Subscribed,
  SubscribeRequest,
  Target,
  Window,
} from '#src/generated/protocol';

/** A shell with several tabs delivers each tab only the events of its own subscriptions and replies. */
export interface Link {
  handshake(): Promise<Handshake>;
  subscribe(request: SubscribeRequest): Promise<Subscribed>;
  unsubscribe(sub: SubId): Promise<void>;
  resync(sub: SubId): Promise<Snapshot>;
  range(sub: SubId, window: Window | null): Promise<Snapshot>;
  dispatch(target: Target, action: unknown): Promise<void>;
  request(target: Target, action: unknown): Promise<ReqId>;
  onBatch(listener: (batch: Batch) => void): () => void;
  onRestart?(listener: () => void): () => void;
}
