import type { Attachment } from 'svelte/attachments';

const ITEM = 'button, a[href], [role="tab"]';
const TREE_ITEM = '[role="treeitem"]';

interface Options {
  orientation?: 'horizontal' | 'vertical';
  selector?: string;
  loop?: boolean;
  /** WAI-ARIA tree: vertical movement over treeitems, Right and Left expand, collapse or change level. */
  tree?: boolean;
}

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
        if (focusLost) replacement?.focus();
      }
      current ??= all.find((item) => item.matches(SELECTED)) ?? all[0];
      order = all;
      for (const item of all) item.tabIndex = item === current ? 0 : -1;
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && items().includes(target)) {
        current = target;
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
      let target: HTMLElement | undefined;
      const focused = event.target;
      if (tree && event.key === 'ArrowRight') {
        const expanded = focused.getAttribute('aria-expanded');
        if (expanded === 'false') {
          event.preventDefault();
          focused.click();
          return;
        }
        const child = all.at(index + 1);
        if (expanded === 'true' && child && level(child) > level(focused)) target = child;
      } else if (tree && event.key === 'ArrowLeft') {
        if (focused.getAttribute('aria-expanded') === 'true') {
          event.preventDefault();
          focused.click();
          return;
        }
        for (let at = index - 1; at >= 0 && !target; at--) {
          if (level(all[at]) < level(focused)) target = all[at];
        }
      } else if (tree && event.key === ' ' && focused instanceof HTMLAnchorElement) {
        event.preventDefault();
        focused.click();
        return;
      } else if (event.key === next) target = step(1);
      else if (event.key === previous) target = step(-1);
      else if (event.key === 'Home') target = all[0];
      else if (event.key === 'End') target = all[all.length - 1];
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
    container.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('keydown', onKeyDown);
    };
  };
}
