import { flushSync } from 'svelte';
import type { Attachment } from 'svelte/attachments';

const OVERSCAN_ROWS = 10;
const FALLBACK_ROW_HEIGHT = 36;
const FALLBACK_VIEWPORT_ROWS = 50;
const ROW = '[data-row-key]';
const END = '[data-window-end]';

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Mounts only the rows of a list near the viewport of its scroll container. Each row's measured
 * height is remembered so the spacers stay exact.
 */
export class ListWindow {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- recomputation is driven by #version
  #heights = new Map<string, number>();
  #base = $state(FALLBACK_ROW_HEIGHT);
  #version = $state(0);
  #scrolledPast = $state(0);
  #viewportHeight = $state(0);
  #list: HTMLElement | undefined;
  #scroller: HTMLElement | undefined;

  readonly #keys: () => readonly string[];
  readonly #scrollerSelector: string;
  readonly #offsets: number[];
  readonly first: number;
  readonly last: number;

  constructor(keys: () => readonly string[], scrollerSelector: string) {
    this.#keys = keys;
    this.#scrollerSelector = scrollerSelector;
    this.#offsets = $derived.by(() => {
      void this.#version;
      const offsets = [0];
      for (const key of keys()) {
        offsets.push(offsets[offsets.length - 1] + (this.#heights.get(key) ?? this.#base));
      }
      return offsets;
    });
    this.first = $derived(Math.max(0, this.#indexAt(this.#scrolledPast) - OVERSCAN_ROWS));
    this.last = $derived(
      Math.min(
        keys().length,
        this.#indexAt(
          this.#scrolledPast + (this.#viewportHeight || FALLBACK_VIEWPORT_ROWS * this.#base)
        ) +
          1 +
          OVERSCAN_ROWS
      )
    );
  }

  get spaceBefore(): number {
    return this.#offsets[Math.min(this.first, this.#keys().length)];
  }

  get spaceAfter(): number {
    return this.#offsets[this.#keys().length] - this.#offsets[this.last];
  }

  reveal(index: number): void {
    const list = this.#list;
    const scroller = this.#scroller;
    if (!list || !scroller) return;
    const rowTop = this.#listTop(list, scroller) + this.#offsets[index];
    const height = this.#offsets[index + 1] - this.#offsets[index];
    if (
      rowTop >= scroller.scrollTop &&
      rowTop + height <= scroller.scrollTop + scroller.clientHeight
    ) {
      return;
    }
    scroller.scrollTop = rowTop - (scroller.clientHeight - height) / 2;
    this.#measure(list, scroller);
  }

  attach: Attachment<HTMLElement> = (list) => {
    const scroller = list.closest<HTMLElement>(this.#scrollerSelector);
    if (!scroller) return;
    this.#list = list;
    this.#scroller = scroller;
    let frame = 0;
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        const anchor = this.#firstVisibleRow(list, scroller);
        const top = anchor?.getBoundingClientRect().top;
        this.#measure(list, scroller);
        flushSync();
        const shift = anchor?.isConnected ? anchor.getBoundingClientRect().top - (top ?? 0) : 0;
        // Setting scrollTop stops momentum scrolling on WebKit, so leave it alone when nothing moved.
        if (shift !== 0) scroller.scrollTop += shift;
      });
    };
    this.#measure(list, scroller);
    scroller.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', schedule);
      this.#list = undefined;
      this.#scroller = undefined;
    };
  };

  /** The last row whose top is at or above the offset. */
  #indexAt(offset: number): number {
    const offsets = this.#offsets;
    let low = 0;
    let high = offsets.length - 2;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (offsets[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return Math.max(0, low);
  }

  #firstVisibleRow(list: HTMLElement, scroller: HTMLElement): HTMLElement | undefined {
    const top = scroller.getBoundingClientRect().top;
    const rows = list.parentElement?.querySelectorAll<HTMLElement>(ROW) ?? [];
    return [...rows].find((row) => row.getBoundingClientRect().bottom > top);
  }

  #listTop(list: HTMLElement, scroller: HTMLElement): number {
    return (
      list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    );
  }

  /** A row's height runs to the next row, which includes anything rendered under its wrapper. */
  #measureRows(list: HTMLElement): boolean {
    const mounted = list.parentElement?.querySelectorAll<HTMLElement>(`${ROW}, ${END}`) ?? [];
    const measured: { key: string; top: number }[] = [];
    let end: number | undefined;
    for (const element of mounted) {
      if (element.matches(END)) {
        end = element.getBoundingClientRect().top;
        break;
      }
      measured.push({
        key: element.dataset.rowKey ?? '',
        top: element.getBoundingClientRect().top,
      });
    }
    if (end === undefined) return false;
    const heights = measured.map(({ top }, index) => (measured[index + 1]?.top ?? end) - top);
    let changed = false;
    for (const [index, { key }] of measured.entries()) {
      const height = heights[index];
      if (height > 0 && this.#heights.get(key) !== height) {
        this.#heights.set(key, height);
        changed = true;
      }
    }
    const known = heights.filter((height) => height > 0);
    if (known.length > 0 && this.#base !== median(known)) {
      this.#base = median(known);
      changed = true;
    }
    return changed;
  }

  #measure(list: HTMLElement, scroller: HTMLElement): void {
    if (this.#measureRows(list)) this.#version += 1;
    this.#scrolledPast = scroller.scrollTop - this.#listTop(list, scroller);
    this.#viewportHeight = Math.min(scroller.clientHeight, window.innerHeight);
  }
}
