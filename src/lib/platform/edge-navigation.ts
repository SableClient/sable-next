import { isTauri } from '@tauri-apps/api/core';
import { on } from 'svelte/events';

const EDGE = 20;
const CONTROL_SELECTOR = 'a, button, label, select, [role="button"], [role="link"], [role="tab"]';

function isIosBrowser(): boolean {
  const agent = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(agent) || (agent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

export function blockEdgeNavigation(): () => void {
  if (isTauri() || !isIosBrowser()) return () => {};

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
