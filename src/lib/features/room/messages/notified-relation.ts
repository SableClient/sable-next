import { isRecord } from '#lib/guards.js';

export interface NotifiedRelation {
  eventId: string;
  thread: boolean;
}

export function notifiedRelation(source: string): NotifiedRelation | null {
  let event: unknown;
  try {
    event = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(event) || !isRecord(event.content)) return null;
  const relation = event.content['m.relates_to'];
  if (!isRecord(relation) || typeof relation.event_id !== 'string') return null;
  if (relation.rel_type === 'm.thread') return { eventId: relation.event_id, thread: true };
  if (relation.rel_type === 'm.replace' || relation.rel_type === 'm.annotation')
    return { eventId: relation.event_id, thread: false };
  return null;
}
