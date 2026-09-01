import { tick } from 'svelte';

const SETTINGS_SCROLL_SELECTOR = '.settings-scroll';

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

export function scrollSettingRowIntoView(row: HTMLElement): void {
  const scroller = row.closest(SETTINGS_SCROLL_SELECTOR);
  if (!(scroller instanceof HTMLElement)) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  const rowRect = row.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const top =
    scroller.scrollTop +
    (rowRect.top - scrollerRect.top) -
    (scroller.clientHeight - row.offsetHeight) / 2;

  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
