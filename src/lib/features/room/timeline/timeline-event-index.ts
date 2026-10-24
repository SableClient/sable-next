import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { isRecord } from '#lib/guards.js';

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

export function isEditEvent(item: ResolvedItem): boolean {
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

export function redactionTarget(item: ResolvedItem): string | null {
  const content = item.content;
  if (content.kind !== 'hidden_event' || content.event_type !== 'm.room.redaction') return null;
  if (content.redacts) return content.redacts;
  return isRecord(content.content) && typeof content.content.redacts === 'string'
    ? content.content.redacts
    : null;
}

export class TimelineEventIndex {
  readonly #items: readonly ResolvedItem[];
  readonly #aggregations: readonly ResolvedItem[];
  #byId: Map<string, ResolvedItem> | null = null;
  #edits: Map<string, ResolvedItem[]> | null = null;
  #reasons: Map<string, string> | null = null;
  #redactors: Map<string, string> | null = null;

  constructor(items: readonly ResolvedItem[], aggregations: readonly ResolvedItem[]) {
    this.#items = items;
    this.#aggregations = aggregations;
  }

  get(eventId: string): ResolvedItem | null {
    if (this.#byId === null) {
      this.#byId = new Map();
      for (const item of [...this.#items, ...this.#aggregations]) {
        if (item.event_id) this.#byId.set(item.event_id, item);
      }
    }
    return this.#byId.get(eventId) ?? null;
  }

  redactionReason(eventId: string): string | null {
    if (this.#reasons === null) {
      this.#reasons = new Map();
      for (const item of this.#aggregations) {
        const target = redactionTarget(item);
        if (!target || item.content.kind !== 'hidden_event' || !isRecord(item.content.content))
          continue;
        const reason = item.content.content.reason;
        if (typeof reason === 'string' && reason.trim() !== '') this.#reasons.set(target, reason);
      }
    }
    return this.#reasons.get(eventId) ?? null;
  }

  redactor(item: ResolvedItem): string | null {
    if (item.content.kind !== 'redacted') return null;
    if (this.#redactors === null) {
      this.#redactors = new Map();
      for (const aggregation of this.#aggregations) {
        const target = redactionTarget(aggregation);
        if (target && aggregation.sender) this.#redactors.set(target, aggregation.sender);
      }
    }
    const by =
      item.content.redacted_by ?? (item.event_id ? this.#redactors.get(item.event_id) : null);
    return by && by !== item.sender ? by : null;
  }

  editBefore(edit: ResolvedItem): ResolvedItem | null {
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
    let previous: ResolvedItem | null = null;
    for (const candidate of this.#edits.get(target) ?? []) {
      if (candidate.event_id === edit.event_id || candidate.timestamp > edit.timestamp) continue;
      if (previous === null || candidate.timestamp >= previous.timestamp) previous = candidate;
    }
    return previous;
  }
}
