import { getContext, setContext, tick } from 'svelte';

import { scrollBehavior } from '#lib/ui/motion.js';

const SETTINGS_SCROLL_SELECTOR = '.settings-scroll';
const FOCUS_KEY = Symbol('settings-focus');

type Focus = () => string | null;

export function provideSettingsFocus(focus: Focus): void {
  setContext(FOCUS_KEY, focus);
}

export function settingsFocus(): Focus {
  return getContext<Focus | undefined>(FOCUS_KEY) ?? (() => null);
}

export async function findSettingRow(id: string): Promise<HTMLElement | null> {
  await tick();
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = document.getElementById(id);
    if (row instanceof HTMLElement) return row;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }
  return null;
}

export function scrollSettingRowIntoView(
  row: HTMLElement,
  block: 'center' | 'start' = 'center'
): void {
  const behavior = scrollBehavior();
  const scroller = row.closest(SETTINGS_SCROLL_SELECTOR);
  if (!(scroller instanceof HTMLElement)) {
    row.scrollIntoView({ block, behavior });
    return;
  }

  const rowRect = row.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const offset =
    block === 'center'
      ? (scroller.clientHeight - row.offsetHeight) / 2
      : parseFloat(getComputedStyle(scroller).fontSize);
  const top = scroller.scrollTop + (rowRect.top - scrollerRect.top) - offset;

  scroller.scrollTo({ top: Math.max(0, top), behavior });
}
