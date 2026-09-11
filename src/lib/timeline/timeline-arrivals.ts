interface EventIdentity {
  id: string;
  event_id: string | null;
  is_own: boolean;
}

export class TimelineArrivals {
  private previous: Set<string> | null = null;
  private tail: string | null = null;

  reset(): void {
    this.previous = null;
    this.tail = null;
  }

  update<T extends EventIdentity>(items: readonly T[]): T[] {
    const events = items.filter((item): item is T & { event_id: string } => item.event_id !== null);
    const previous = this.previous;
    const tailIndex =
      this.tail === null ? -1 : events.findIndex((item) => item.event_id === this.tail);
    const arrivals =
      previous !== null && (this.tail === null || tailIndex >= 0)
        ? events.slice(tailIndex + 1).filter((item) => !item.is_own && !previous.has(item.event_id))
        : [];
    this.previous = new Set(events.map((item) => item.event_id));
    this.tail = events.at(-1)?.event_id ?? null;
    return arrivals;
  }
}
