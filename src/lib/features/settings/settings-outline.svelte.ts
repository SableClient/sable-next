import { untrack } from 'svelte';

import { scrollBehavior } from '#lib/ui/motion.js';

const OUTLINE_HEADING_SELECTOR = '[data-settings-outline][id]';

interface OutlineEntry {
  id: string;
  label: string;
}

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

function sameEntries(a: readonly OutlineEntry[], b: readonly OutlineEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => entry.id === b[index]?.id && entry.label === b[index]?.label)
  );
}

export class OutlineTracker {
  entries = $state.raw<OutlineEntry[]>([]);
  activeId = $state<string | null>(null);

  #scroller: HTMLElement | null = null;
  #pinned: string | null = null;
  #frame = 0;

  track = (scroller: HTMLElement): (() => void) => {
    this.#scroller = scroller;
    untrack(() => {
      this.#collect();
    });

    const observer = new MutationObserver(() => {
      this.#collect();
    });
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });

    const onScroll = (): void => {
      if (this.#frame) return;
      this.#frame = requestAnimationFrame(() => {
        this.#frame = 0;
        this.#spy();
      });
    };
    const release = (): void => {
      this.#pinned = null;
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    for (const type of USER_SCROLL_EVENTS) {
      scroller.addEventListener(type, release, { passive: true });
    }

    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, release);
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
      this.#scroller = null;
      this.#pinned = null;
      this.entries = [];
      this.activeId = null;
    };
  };

  jump(id: string): void {
    const scroller = this.#scroller;
    const heading = scroller?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!scroller || !heading) return;

    const target = heading.closest('section') ?? heading;
    const gap = parseFloat(getComputedStyle(scroller).fontSize);
    const top =
      scroller.scrollTop +
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      gap;

    this.#pinned = id;
    this.activeId = id;
    scroller.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  #headings(): HTMLElement[] {
    return this.#scroller
      ? [...this.#scroller.querySelectorAll<HTMLElement>(OUTLINE_HEADING_SELECTOR)]
      : [];
  }

  #collect(): void {
    const next = this.#headings().map((heading) => ({
      id: heading.id,
      label: heading.textContent.trim(),
    }));
    if (!sameEntries(next, this.entries)) {
      this.entries = next;
      if (this.#pinned !== null && !next.some((entry) => entry.id === this.#pinned)) {
        this.#pinned = null;
      }
    }
    this.#spy();
  }

  #spy(): void {
    const scroller = this.#scroller;
    if (!scroller) return;
    if (this.#pinned !== null) {
      this.activeId = this.#pinned;
      return;
    }

    const headings = this.#headings();
    const last = headings.at(-1);
    if (!last) {
      this.activeId = null;
      return;
    }

    const scrollable = scroller.scrollHeight > scroller.clientHeight;
    if (scrollable && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
      this.activeId = last.id;
      return;
    }

    const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 4;
    let current = headings[0].id;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top > line) break;
      current = heading.id;
    }
    this.activeId = current;
  }
}
