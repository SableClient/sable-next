import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { isRecord } from '#lib/guards.js';

export async function redactReaction(
  commands: Pick<CoreCommands, 'roomEventRelations' | 'sendRedaction'>,
  roomId: string,
  eventId: string,
  key: string,
  sender: string
): Promise<void> {
  const eventIds = new Set<string>();
  const seenPages = new Set<string>();
  let from: string | undefined;
  do {
    const page = await commands.roomEventRelations(roomId, eventId, {
      relType: 'm.annotation',
      eventType: 'm.reaction',
      from,
      limit: 100,
    });
    for (const event of page.chunk) {
      if (
        !isRecord(event) ||
        event.type !== 'm.reaction' ||
        event.sender !== sender ||
        typeof event.event_id !== 'string' ||
        !isRecord(event.content)
      )
        continue;
      const relation = event.content['m.relates_to'];
      if (
        isRecord(relation) &&
        relation.rel_type === 'm.annotation' &&
        relation.event_id === eventId &&
        relation.key === key
      )
        eventIds.add(event.event_id);
    }
    from = page.next_batch ?? undefined;
    if (from !== undefined) {
      if (seenPages.has(from)) throw new Error('Reaction pagination did not advance');
      seenPages.add(from);
    }
  } while (from !== undefined);

  for (const reactionId of eventIds) {
    await commands.sendRedaction(roomId, reactionId, null);
  }
}
