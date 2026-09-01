export interface AnchorViewport {
  /** Viewport-relative, or null when the row is not rendered. */
  topOf(key: string): number | null;
  visibleRows(): readonly AnchorSnapshot[];
  scrollBy(delta: number): void;
  offset(): number;
}

export interface AnchorSnapshot {
  readonly key: string;
  readonly top: number;
}

export const ANCHOR_EPSILON = 0.5;

export class TimelineAnchor {
  #candidates: readonly AnchorSnapshot[] = [];
  #resolved: AnchorSnapshot | null = null;
  #offset: number | null = null;

  constructor(private readonly getViewport: () => AnchorViewport | null) {}

  capture(): void {
    const viewport = this.getViewport();
    this.#resolved = null;
    this.#candidates = viewport === null ? [] : viewport.visibleRows();
    this.#offset = viewport?.offset() ?? null;
  }

  restore(): number | null {
    const viewport = this.getViewport();
    if (!viewport) return null;
    for (const candidate of this.#candidates) {
      const top = viewport.topOf(candidate.key);
      if (top === null) continue;
      this.#resolved = candidate;
      const delta = top - candidate.top;
      if (Math.abs(delta) < ANCHOR_EPSILON) return delta;
      viewport.scrollBy(delta);
      this.#offset = viewport.offset();
      const settled = viewport.topOf(candidate.key);
      return settled === null ? null : settled - candidate.top;
    }
    return null;
  }

  restoreStationary(): number | null {
    const viewport = this.getViewport();
    if (!viewport) return null;
    if (this.#offset === null || Math.abs(viewport.offset() - this.#offset) > ANCHOR_EPSILON) {
      this.capture();
      return null;
    }
    return this.restore();
  }

  locate(indexOfKey: (key: string) => number): { snapshot: AnchorSnapshot; index: number } | null {
    for (const snapshot of this.#candidates) {
      const index = indexOfKey(snapshot.key);
      if (index >= 0) return { snapshot, index };
    }
    return null;
  }

  shift(delta: number): void {
    this.#candidates = this.#candidates.map(({ key, top }) => ({ key, top: top + delta }));
    if (this.#resolved) this.#resolved = { ...this.#resolved, top: this.#resolved.top + delta };
  }

  release(): void {
    this.#candidates = [];
    this.#resolved = null;
  }

  get held(): AnchorSnapshot | null {
    return this.#resolved ?? this.#candidates.at(0) ?? null;
  }
}

const ITEM_KEY_PREFIX = 'item:';

export function anchorKeyForItem(item: { id: string; event_id: string | null }): string {
  return item.event_id ?? `${ITEM_KEY_PREFIX}${item.id}`;
}

function rowSelector(key: string): string {
  return key.startsWith(ITEM_KEY_PREFIX)
    ? `.item[data-item-id="${CSS.escape(key.slice(ITEM_KEY_PREFIX.length))}"]`
    : `.item[data-event-id="${CSS.escape(key)}"]`;
}

export function domAnchorViewport(viewport: HTMLElement): AnchorViewport {
  const rowTop = (row: Element, viewportTop: number): number =>
    row.getBoundingClientRect().top - viewportTop;

  return {
    topOf(key) {
      const row = viewport.querySelector(rowSelector(key));
      return row === null ? null : rowTop(row, viewport.getBoundingClientRect().top);
    },
    visibleRows() {
      const viewportTop = viewport.getBoundingClientRect().top;
      const height = viewport.clientHeight;
      const events: AnchorSnapshot[] = [];
      const clipped: AnchorSnapshot[] = [];
      const virtual: AnchorSnapshot[] = [];
      for (const row of viewport.querySelectorAll<HTMLElement>('.item[data-item-id]')) {
        const itemId = row.dataset.itemId;
        if (itemId === undefined) continue;
        const eventId = row.dataset.eventId;
        const top = rowTop(row, viewportTop);
        if (top >= height || top + row.offsetHeight <= 0) continue;
        if (eventId === undefined) virtual.push({ key: `${ITEM_KEY_PREFIX}${itemId}`, top });
        // The row straddling the top edge is the one a prepend reshapes: what
        // precedes it changes, so it gains or loses its sender header.
        else if (top < 0) clipped.push({ key: eventId, top });
        else events.push({ key: eventId, top });
      }
      // A divider never moves when history is prepended into its day, and absolute
      // positioning means document order is not visual order.
      const byTop = (left: AnchorSnapshot, right: AnchorSnapshot): number => left.top - right.top;
      return [...events.sort(byTop), ...clipped.sort(byTop), ...virtual.sort(byTop)];
    },
    scrollBy(delta) {
      viewport.scrollBy(0, delta);
    },
    offset() {
      return viewport.scrollTop;
    },
  };
}
