import { notifiedRelation } from '#lib/features/room/messages/notified-relation.js';

/** Finds the thread a forum permalink belongs to; edits and reactions resolve to the event they modify. */
export async function resolveForumLink(
  readSource: (eventId: string) => Promise<string>,
  eventId: string
): Promise<{ rootEventId: string; eventId: string }> {
  const relation = notifiedRelation(await readSource(eventId));
  if (relation === null) return { rootEventId: eventId, eventId };
  if (relation.thread) return { rootEventId: relation.eventId, eventId };
  const original = notifiedRelation(await readSource(relation.eventId));
  return {
    rootEventId: original?.thread ? original.eventId : relation.eventId,
    eventId: relation.eventId,
  };
}
