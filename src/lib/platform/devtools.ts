import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { on } from 'svelte/events';

export function trackInspectorShortcut(): () => void {
  if (!isTauri() || osType() === 'android' || osType() === 'ios') return () => {};

  return on(window, 'keydown', (event) => {
    if (event.key !== 'F12' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void invoke('toggle_devtools');
  });
}
