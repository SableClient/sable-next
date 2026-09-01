import type { TimelineItemView } from '#src/generated/TimelineItemView';

const MAX_LOCAL_ECHO_IDS = 512;

export class TimelineIdentityTracker {
  private readonly localEchoItemIds = new Set<string>();
  private readonly keysByItems = new WeakMap<readonly TimelineItemView[], readonly string[]>();

  key(items: readonly TimelineItemView[], index: number): string {
    if (index < 0 || index >= items.length) return 'missing';
    return this.keysFor(items)[index];
  }

  reconcile(items: readonly TimelineItemView[]): void {
    const activeIds = new Set(items.map((item) => item.id));
    for (const id of this.localEchoItemIds) {
      if (!activeIds.has(id)) this.localEchoItemIds.delete(id);
    }
    if (this.localEchoItemIds.size <= MAX_LOCAL_ECHO_IDS) return;
    const ids = [...this.localEchoItemIds];
    for (const id of ids.slice(0, ids.length - MAX_LOCAL_ECHO_IDS)) {
      this.localEchoItemIds.delete(id);
    }
  }

  size(): number {
    return this.localEchoItemIds.size;
  }

  private keysFor(items: readonly TimelineItemView[]): readonly string[] {
    const cached = this.keysByItems.get(items);
    if (cached) return cached;
    const seen = new Set<string>();
    const keys = items.map((_item, index) => {
      const base = this.baseKey(items, index);
      let key = base;
      for (let attempt = 1; seen.has(key); attempt += 1) key = `${base}#${attempt}`;
      seen.add(key);
      return key;
    });
    this.keysByItems.set(items, keys);
    return keys;
  }

  private baseKey(items: readonly TimelineItemView[], index: number): string {
    const item = items[index];
    const eventKey = this.eventKey(item);
    if (eventKey) return eventKey;
    if (item.content.kind === 'date_divider' || item.content.kind === 'timeline_start') {
      for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
        const nextEventKey = this.eventKey(items[nextIndex]);
        if (nextEventKey) return `boundary:${item.id}:${nextEventKey}`;
      }
    }
    return `item:${item.id}`;
  }

  private eventKey(item: TimelineItemView | undefined): string | null {
    if (!item) return null;
    if (item.transaction_id) this.localEchoItemIds.add(item.id);
    if (this.localEchoItemIds.has(item.id)) return `item:${item.id}`;
    if (item.event_id) return `event:${item.event_id}`;
    if (item.transaction_id) return `transaction:${item.transaction_id}`;
    return null;
  }
}
