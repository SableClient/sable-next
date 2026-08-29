import { on } from 'svelte/events';

import { isDialogOpen, isEditableTarget, matchesBinding } from './binding.js';
import { SHORTCUTS, type ShortcutId } from './shortcuts.js';

export type ShortcutHandlers = Partial<Record<ShortcutId, (event: KeyboardEvent) => void>>;

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function registerGlobalShortcuts(handlers: ShortcutHandlers): () => void {
  return on(window, 'keydown', (event) => {
    if (isDialogOpen()) return;

    const isMac = isMacPlatform();

    for (const shortcut of SHORTCUTS) {
      const handler = handlers[shortcut.id];
      if (!handler) continue;
      if (!shortcut.allowInEditable && isEditableTarget(event.target)) continue;
      if (!matchesBinding(shortcut.binding, event, isMac)) continue;

      event.preventDefault();
      handler(event);
      return;
    }
  });
}
