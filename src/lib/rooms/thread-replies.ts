import type { CoreClient } from '#lib/core/client.svelte.js';
import type { ThreadReplyView } from '#src/generated/protocol';

const MAX_CACHE_ENTRIES = 200;
const cache = new Map<string, readonly ThreadReplyView[]>();
const inflight = new Map<string, Promise<readonly ThreadReplyView[]>>();

function cacheKey(roomId: string, rootId: string, revision: string): string {
  return `${roomId}\0${rootId}\0${revision}`;
}

export function threadReplyRevision(summary: {
  num_replies: number;
  latest_event_id: string | null;
}): string {
  return `${summary.num_replies}:${summary.latest_event_id ?? ''}`;
}

export function cachedThreadReplies(
  roomId: string,
  rootId: string,
  revision: string
): readonly ThreadReplyView[] | undefined {
  return cache.get(cacheKey(roomId, rootId, revision));
}

export function loadThreadReplies(
  core: CoreClient,
  roomId: string,
  rootId: string,
  revision: string
): Promise<readonly ThreadReplyView[]> {
  const key = cacheKey(roomId, rootId, revision);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = core.rpc.timeline
    .threadReplies({ room_id: roomId, root_event_id: rootId, limit: 50 })
    .then((replies) => {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, replies);
      return replies;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

export function threadParticipants(replies: readonly ThreadReplyView[]): string[] {
  return [...new Set(replies.map((reply) => reply.sender))];
}

export function clearThreadRepliesCache(): void {
  cache.clear();
  inflight.clear();
}
