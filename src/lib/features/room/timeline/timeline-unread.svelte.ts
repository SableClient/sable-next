import type { TimelineItemView } from '#src/generated/protocol';
import { isUnreadMessage, unreadCountAfter } from './timeline-format';

export class TimelineUnread {
  initialized = $state(false);
  loading = $state(false);
  active = $state(false);
  reached = $state(false);
  firstEventId = $state<string | null>(null);
  failed = $state(false);
  #readEventId: string | null = null;
  #disposed = false;
  #task: Promise<void> | null = null;

  get readEventId(): string | null {
    return this.#readEventId;
  }

  get blocking(): boolean {
    return !this.initialized || this.loading || (this.active && !this.reached);
  }

  initialize(
    items: readonly TimelineItemView[],
    hasUnread: boolean,
    load?: () => Promise<string | null>,
    visibleItems: readonly TimelineItemView[] = items
  ): Promise<void> {
    if (this.#task) return this.#task;
    if (this.initialized && !this.failed) return Promise.resolve();
    if (!this.initialized) {
      this.active = items.some((item) => item.content.kind === 'read_marker') || hasUnread;
    }
    this.initialized = true;
    this.failed = false;
    this.resolve(items, false, visibleItems);
    if (!this.active || this.firstEventId !== null || !load) return Promise.resolve();
    this.loading = true;
    this.#task = load()
      .then((eventId) => {
        if (!this.#disposed) this.#readEventId = eventId;
      })
      .catch(() => {
        if (!this.#disposed) this.failed = true;
      })
      .finally(() => {
        if (!this.#disposed) this.loading = false;
        this.#task = null;
      });
    return this.#task;
  }

  resolve(
    items: readonly TimelineItemView[],
    oldestLoaded: boolean,
    visibleItems: readonly TimelineItemView[] = items
  ): void {
    if (!this.active || this.loading || this.failed) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt for each boundary resolution
    const visibleIds = new Set(visibleItems.filter(isUnreadMessage).map((item) => item.event_id));
    if (this.firstEventId !== null) {
      if (visibleIds.has(this.firstEventId)) return;
      const index = items.findIndex((item) => item.event_id === this.firstEventId);
      if (index < 0) return;
      const next = items.slice(index + 1).find((item) => visibleIds.has(item.event_id));
      if (next) this.firstEventId = next.event_id;
      return;
    }
    const marker = items.findIndex((item) => item.content.kind === 'read_marker');
    const read =
      this.#readEventId === null
        ? -1
        : items.findIndex((item) => item.event_id === this.#readEventId);
    const boundary = marker >= 0 ? marker : read;
    if (boundary < 0 && !oldestLoaded) return;
    const first = items.slice(boundary + 1).find((item) => visibleIds.has(item.event_id));
    if (first) this.firstEventId = first.event_id;
    else if (boundary >= 0 || oldestLoaded) this.dismiss();
  }

  count(items: readonly TimelineItemView[]): number {
    const index = items.findIndex((item) => item.event_id === this.firstEventId);
    return index < 0 ? 0 : unreadCountAfter(items, index - 1);
  }

  observe(firstVisible: string | null): void {
    if (this.active && firstVisible === this.firstEventId && firstVisible !== null) {
      this.reached = true;
    }
  }

  dismiss(): void {
    this.active = false;
    this.reached = true;
  }

  destroy(): void {
    this.#disposed = true;
  }
}
