import type { Batch } from '#src/generated/protocol';
import type { Link } from '../lib/runtime/link';

export type AppRemote = Omit<Link, 'onBatch' | 'onRestart'>;
export type AppRequest = { op: 'hello'; tab: string } | { op?: never };

export type AppMessage = { batch: Batch } | { crashed: true } | { superseded: true };
