import { invoke, isTauri } from '@tauri-apps/api/core';
import { on } from 'svelte/events';

import { isNativeMobile } from './os';

export function trackInspectorShortcut(): () => void {
  if (!isTauri() || isNativeMobile()) return () => {};

  return on(window, 'keydown', (event) => {
    if (event.key !== 'F12' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void invoke('toggle_devtools');
  });
}
