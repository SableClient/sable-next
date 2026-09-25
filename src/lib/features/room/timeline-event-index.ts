import { isRecord } from '#lib/guards.js';
import type { TimelineItemView } from '#src/generated/protocol';

export interface Relation {
  eventId: string;
  relType: string | null;
}

export function relationOf(content: unknown): Relation | null {
  if (!isRecord(content)) return null;
  const relation = content['m.relates_to'];
  if (!isRecord(relation) || typeof relation.event_id !== 'string') return null;
  return {
    eventId: relation.event_id,
    relType: typeof relation.rel_type === 'string' ? relation.rel_type : null,
  };
}

export function isEditEvent(item: TimelineItemView): boolean {
  return (
    item.content.kind === 'hidden_event' &&
    item.content.event_type === 'm.room.message' &&
    relationOf(item.content.content)?.relType === 'm.replace'
  );
}

export function editedBody(content: unknown): string | null {
  if (!isRecord(content)) return null;
  const replacement = content['m.new_content'];
  return isRecord(replacement) && typeof replacement.body === 'string' ? replacement.body : null;
}

export function redactionTarget(item: TimelineItemView): string | null {
  const content = item.content;
  if (content.kind !== 'hidden_event' || content.event_type !== 'm.room.redaction') return null;
  if (content.redacts) return content.redacts;
  return isRecord(content.content) && typeof content.content.redacts === 'string'
    ? content.content.redacts
    : null;
}

export class TimelineEventIndex {
  readonly #items: readonly TimelineItemView[];
  readonly #aggregations: readonly TimelineItemView[];
  #byId: Map<string, TimelineItemView> | null = null;
  #edits: Map<string, TimelineItemView[]> | null = null;

  constructor(items: readonly TimelineItemView[], aggregations: readonly TimelineItemView[]) {
    this.#items = items;
    this.#aggregations = aggregations;
  }

  get(eventId: string): TimelineItemView | null {
    if (this.#byId === null) {
      this.#byId = new Map();
      for (const item of [...this.#items, ...this.#aggregations]) {
        if (item.event_id) this.#byId.set(item.event_id, item);
      }
    }
    return this.#byId.get(eventId) ?? null;
  }

  editBefore(edit: TimelineItemView): TimelineItemView | null {
    if (edit.content.kind !== 'hidden_event') return null;
    const target = relationOf(edit.content.content)?.eventId;
    if (!target) return null;
    if (this.#edits === null) {
      this.#edits = new Map();
      for (const item of this.#aggregations) {
        if (!isEditEvent(item) || item.content.kind !== 'hidden_event') continue;
        const of = relationOf(item.content.content)?.eventId;
        if (!of) continue;
        const list = this.#edits.get(of) ?? [];
        list.push(item);
        this.#edits.set(of, list);
      }
    }
    let previous: TimelineItemView | null = null;
    for (const candidate of this.#edits.get(target) ?? []) {
      if (candidate.event_id === edit.event_id || candidate.timestamp > edit.timestamp) continue;
      if (previous === null || candidate.timestamp >= previous.timestamp) previous = candidate;
    }
    return previous;
  }
}
