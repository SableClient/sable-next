import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type ScrollToOptions,
  type VirtualItem,
  type VirtualizerOptions,
} from '@tanstack/virtual-core';
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

type Options = VirtualizerOptions<HTMLElement, HTMLElement>;
interface Adjustable {
  applyScrollAdjustment: (delta: number) => boolean;
}

interface WindowOptions {
  count: number;
  key: (index: number) => string;
  overscan: number;
  estimate?: number;
  size?: (index: number) => number;
  keep?: number;
}

export class VirtualWindow {
  #version = $state(0);
  #changes = 0;
  #scroller: HTMLElement | null = null;
  #start: HTMLElement | null = null;
  #options: Options;
  readonly #virtualizer: Virtualizer<HTMLElement, HTMLElement>;

  constructor(options: () => WindowOptions) {
    this.#options = {
      count: 0,
      getScrollElement: () => this.#scroller,
      estimateSize: () => 0,
      scrollToFn: elementScroll,
      initialRect: { width: 0, height: window.innerHeight },
      observeElementRect: (instance, report) =>
        observeElementRect(instance, (rect) => {
          report(rect.height > 0 ? rect : { ...rect, height: window.innerHeight });
        }),
      observeElementOffset,
      onChange: () => {
        this.#bump();
      },
    };
    this.#virtualizer = new Virtualizer(this.#options);
    this.#list = $derived(options());
  }

  readonly #list: WindowOptions;
  #applied: WindowOptions | undefined;
  #syncing = false;

  // On read rather than in an effect, so the rows never index past a shorter list.
  #sync(): void {
    const next = this.#list;
    const previous = this.#applied;
    if (next === previous) return;
    this.#applied = next;
    const estimate = next.estimate ?? 0;
    const keep = next.keep;
    untrack(() => {
      this.#syncing = true;
      try {
        const anchor = this.#visibleAnchor();
        // TanStack also keys rows outside a read, such as on teardown, after the list may have shrunk.
        const keys = Array.from({ length: next.count }, (_, index) => next.key(index));
        this.#update({
          count: next.count,
          getItemKey: (index) => keys[index],
          overscan: next.overscan,
          estimateSize: next.size ?? (() => estimate),
          rangeExtractor: (range) => {
            const rows = defaultRangeExtractor(range);
            if (keep === undefined || keep < 0 || keep >= range.count || rows.includes(keep)) {
              return rows;
            }
            return [...rows, keep].sort((a, b) => a - b);
          },
        });
        if (previous && previous.size !== next.size) this.#virtualizer.measure();
        if (anchor) this.#restoreAnchor(anchor, next);
      } finally {
        this.#syncing = false;
      }
    });
  }

  // TanStack keeps a row in place across data changes only in its chat mode.
  #visibleAnchor(): VirtualItem | undefined {
    const offset = this.#virtualizer.scrollOffset;
    if (offset === null || offset <= (this.#options.scrollMargin ?? 0)) return undefined;
    return this.#virtualizer.getVirtualItemForOffset(offset);
  }

  #restoreAnchor(anchor: VirtualItem, list: WindowOptions): void {
    for (let index = 0; index < list.count; index++) {
      if (list.key(index) !== anchor.key) continue;
      const start = this.#virtualizer.getOffsetForIndex(index, 'start')?.[0] ?? anchor.start;
      // Private in the types, but it defers the write during iOS touch and momentum scrolling.
      (this.#virtualizer as unknown as Adjustable).applyScrollAdjustment(start - anchor.start);
      return;
    }
  }

  get items(): (VirtualItem & { gap: number })[] {
    this.#sync();
    void this.#version;
    return this.#virtualizer
      .getVirtualItems()
      .map((item, at, all) => ({ ...item, gap: at === 0 ? 0 : item.start - all[at - 1].end }));
  }

  get first(): number {
    return this.items.at(0)?.index ?? 0;
  }

  get last(): number {
    return (this.items.at(-1)?.index ?? -1) + 1;
  }

  get spaceBefore(): number {
    const first = this.items.at(0);
    return first ? first.start - (this.#options.scrollMargin ?? 0) : 0;
  }

  get spaceAfter(): number {
    const last = this.items.at(-1);
    const total = this.#virtualizer.getTotalSize();
    return last ? total - (last.end - (this.#options.scrollMargin ?? 0)) : total;
  }

  scrollToIndex(index: number, options?: ScrollToOptions): void {
    this.#sync();
    this.#virtualizer.scrollToIndex(index, options);
  }

  measure: Attachment<HTMLElement> = (row) => {
    this.#virtualizer.measureElement(row);
  };

  scroller: Attachment<HTMLElement> = (scroller) => {
    this.#scroller = scroller;
    this.#update({});
    let frame = 0;
    const syncMargin = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        this.#syncMargin();
      });
    };
    this.#syncMargin();
    scroller.addEventListener('scroll', syncMargin, { passive: true });
    const observer = new ResizeObserver(syncMargin);
    for (const child of scroller.children) observer.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', syncMargin);
      this.#scroller = null;
      this.#update({});
    };
  };

  start: Attachment<HTMLElement> = (start) => {
    this.#start = start;
    this.#syncMargin();
    return () => {
      this.#start = null;
    };
  };

  #syncMargin(): void {
    const scroller = this.#scroller;
    const start = this.#start;
    if (!scroller || !start) return;
    const margin =
      start.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (Math.abs(margin - (this.#options.scrollMargin ?? 0)) >= 1) {
      this.#update({ scrollMargin: margin });
    }
  }

  #update(changes: Partial<Options>): void {
    this.#options = { ...this.#options, ...changes };
    this.#virtualizer.setOptions(this.#options);
    this.#virtualizer._willUpdate();
    this.#bump();
  }

  #bump(): void {
    if (this.#syncing) return;
    this.#version = ++this.#changes;
  }
}
