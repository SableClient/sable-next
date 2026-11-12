import { isTauri } from '@tauri-apps/api/core';
import { on } from 'svelte/events';

import { hasIosUserAgent } from './os.js';

const EDGE = 20;
const CONTROL_SELECTOR = 'a, button, label, select, [role="button"], [role="link"], [role="tab"]';

export function blockEdgeNavigation(): () => void {
  if (isTauri() || !hasIosUserAgent()) return () => {};

  return on(
    document,
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      if (touch.pageX > EDGE && touch.pageX < window.innerWidth - EDGE) return;
      if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) return;
      event.preventDefault();
    },
    { passive: false }
  );
}
