import type { Batch, SubId, SubscribeRequest, Target, Window } from '#src/generated/protocol';
import type { Link } from '../lib/runtime/link';

export type AppRemote = Omit<Link, 'onBatch' | 'onRestart'>;

export type AppRequest =
  | { op: 'hello'; tab: string }
  | { id: number; op: 'handshake' }
  | { id: number; op: 'subscribe'; request: SubscribeRequest }
  | { id: number; op: 'unsubscribe'; sub: SubId }
  | { id: number; op: 'resync'; sub: SubId }
  | { id: number; op: 'range'; sub: SubId; window: Window | null }
  | { id: number; op: 'dispatch'; target: Target; action: unknown }
  | { id: number; op: 'request'; target: Target; action: unknown };

export type AppMessage =
  | { id: number; ok: unknown }
  | { id: number; error: string }
  | { batch: Batch }
  | { crashed: true }
  | { superseded: true };
