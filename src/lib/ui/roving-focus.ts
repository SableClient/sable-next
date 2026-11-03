import type { Attachment } from 'svelte/attachments';

const ITEM = 'button, a[href], [role="tab"]';
const TREE_ITEM = '[role="treeitem"]';

interface Options {
  orientation?: 'horizontal' | 'vertical';
  selector?: string;
  loop?: boolean;
  /** WAI-ARIA tree: vertical movement over treeitems, Right and Left expand, collapse or change level. */
  tree?: boolean;
  /** Vertical only: PageUp and PageDown move this many items. */
  page?: number;
  /** Takes over moves the rendered items cannot satisfy, and every Home, End, PageUp and PageDown. Home and End pass an infinite distance. */
  onBoundary?: (move: 'start' | 'end', from: HTMLElement, distance: number) => void;
  /** Focusable descendants of items are taken out of the tab order unless focus is inside their item. */
  contain?: string;
  /** The item Tab lands on before any item has been focused. */
  initial?: (items: HTMLElement[]) => HTMLElement | undefined;
  /** Move focus to a neighbour when the focused item is removed. */
  restoreFocus?: boolean;
  /** Runs for every item on each sync. */
  annotate?: (item: HTMLElement) => void;
}

const PARKED = 'data-roving-parked';
const SELECTED = '[aria-current="page"], [aria-selected="true"]';

// checkVisibility is missing before Safari 17.4
export const isRendered = (item: HTMLElement) =>
  (item as Partial<HTMLElement>).checkVisibility
    ? item.checkVisibility()
    : item.getClientRects().length > 0;

/** Makes a container one tab stop; arrows, Home and End move between its controls. */
export function rovingFocus({
  orientation = 'horizontal',
  selector,
  loop = false,
  tree = false,
  page = 1,
  onBoundary,
  contain,
  initial,
  restoreFocus = true,
  annotate,
}: Options = {}): Attachment<HTMLElement> {
  const itemSelector = selector ?? (tree ? TREE_ITEM : ITEM);
  const [previous, next] =
    orientation === 'horizontal' && !tree ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  const level = (item: HTMLElement) => Number(item.getAttribute('aria-level') ?? 1);

  return (container) => {
    let current: HTMLElement | undefined;
    let order: HTMLElement[] = [];

    const items = () =>
      [...container.querySelectorAll<HTMLElement>(itemSelector)].filter(
        (item) => !item.matches(':disabled') && isRendered(item)
      );

    const sync = () => {
      const all = items();
      if (current && !all.includes(current)) {
        const focusLost = document.activeElement === document.body;
        const removedAt = Math.min(order.indexOf(current), all.length - 1);
        const replacement = all.at(removedAt);
        current = replacement;
        if (focusLost && restoreFocus) replacement?.focus();
      }
      current ??= all.find((item) => item.matches(SELECTED)) ?? initial?.(all) ?? all[0];
      order = all;
      for (const item of all) {
        item.tabIndex = item === current ? 0 : -1;
        annotate?.(item);
      }
      if (contain) park(all, contain);
    };

    const park = (all: HTMLElement[], selector: string) => {
      const active = document.activeElement;
      const entered = all.find((item) => item !== active && item.contains(active));
      for (const element of container.querySelectorAll<HTMLElement>(selector)) {
        const owner = element.closest(itemSelector);
        if (!owner || owner === element) continue;
        const parked = element.hasAttribute(PARKED);
        if (owner === entered) {
          if (!parked) continue;
          const previous = element.getAttribute(PARKED);
          if (previous) element.setAttribute('tabindex', previous);
          else element.removeAttribute('tabindex');
          element.removeAttribute(PARKED);
        } else if (!parked && element.tabIndex >= 0) {
          element.setAttribute(PARKED, element.getAttribute('tabindex') ?? '');
          element.tabIndex = -1;
        }
      }
    };

    let scheduled = false;
    const syncSoon = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        sync();
      });
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      const item = target instanceof HTMLElement ? target.closest<HTMLElement>(itemSelector) : null;
      if (item && items().includes(item)) {
        current = item;
        sync();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!(event.target instanceof HTMLElement)) return;
      const all = items();
      const index = all.indexOf(event.target);
      if (index < 0) return;
      const step = (offset: number) => {
        const at = index + offset;
        return loop ? all[(at + all.length) % all.length] : all[at];
      };
      const focused = event.target;
      if (tree && event.key === 'ArrowRight') {
        const expanded = focused.getAttribute('aria-expanded');
        if (expanded === 'false') {
          event.preventDefault();
          focused.click();
          return;
        }
        const child = all.at(index + 1);
        if (expanded === 'true' && child && level(child) > level(focused)) {
          event.preventDefault();
          child.focus();
        }
        return;
      }
      if (tree && event.key === 'ArrowLeft') {
        if (focused.getAttribute('aria-expanded') === 'true') {
          event.preventDefault();
          focused.click();
          return;
        }
        const parent = all
          .slice(0, index)
          .reverse()
          .find((item) => level(item) < level(focused));
        if (parent) {
          event.preventDefault();
          parent.focus();
        }
        return;
      }
      if (tree && event.key === ' ' && focused instanceof HTMLAnchorElement) {
        event.preventDefault();
        focused.click();
        return;
      }
      let distance: number;
      if (event.key === next || event.key === previous) distance = 1;
      else if (event.key === 'Home' || event.key === 'End') distance = Infinity;
      else if (orientation === 'vertical' && (event.key === 'PageUp' || event.key === 'PageDown'))
        distance = page;
      else return;
      const toEnd = event.key === next || event.key === 'End' || event.key === 'PageDown';
      const target =
        distance === 1
          ? step(toEnd ? 1 : -1)
          : all.at(
              toEnd ? Math.min(index + distance, all.length - 1) : Math.max(index - distance, 0)
            );
      if (onBoundary && (distance > 1 || !target)) {
        event.preventDefault();
        onBoundary(toEnd ? 'end' : 'start', event.target, distance);
        return;
      }
      if (!target) return;
      event.preventDefault();
      target.focus();
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'aria-expanded'],
    });
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', syncSoon);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', syncSoon);
      container.removeEventListener('keydown', onKeyDown);
    };
  };
}
