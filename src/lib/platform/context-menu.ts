import { isTauri } from '@tauri-apps/api/core';
import { on } from 'svelte/events';

import { isNativeMobile } from './os';

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable=""]';

export function suppressNativeContextMenu(): () => void {
  if (!isTauri() || isNativeMobile()) return () => {};

  return on(document, 'contextmenu', (event) => {
    if (event.target instanceof Element && event.target.closest(EDITABLE_SELECTOR)) return;
    event.preventDefault();
  });
}
