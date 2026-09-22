import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { on } from 'svelte/events';

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable=""]';

export function suppressNativeContextMenu(): () => void {
  if (!isTauri() || osType() === 'android' || osType() === 'ios') return () => {};

  return on(document, 'contextmenu', (event) => {
    if (event.target instanceof Element && event.target.closest(EDITABLE_SELECTOR)) return;
    event.preventDefault();
  });
}
