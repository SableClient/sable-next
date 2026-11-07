import { on } from 'svelte/events';

import { isDialogOpen, isEditableTarget, matchesBinding } from './binding.js';
import { effectiveShortcuts } from './bindings.svelte.js';
import { type ShortcutDefinition, type ShortcutId } from './shortcuts.js';

type ShortcutHandler =
  | ((event: KeyboardEvent) => void)
  | { press: (event: KeyboardEvent) => void; release: () => void };

export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function registerGlobalShortcuts(
  handlers: ShortcutHandlers,
  isEnabled: (shortcut: ShortcutDefinition) => boolean = () => true
): () => void {
  const held = new Map<ShortcutId, { event: KeyboardEvent; release: () => void }>();

  const releaseAll = (): void => {
    const releases = [...held.values()];
    held.clear();
    for (const { release } of releases) release();
  };

  const offKeydown = on(window, 'keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;

    const isMac = isMacPlatform();

    for (const shortcut of effectiveShortcuts()) {
      const handler = handlers[shortcut.id];
      if (!handler || !isEnabled(shortcut)) continue;
      if (!shortcut.allowInEditable && isEditableTarget(event.target)) continue;
      if (
        typeof handler !== 'function' &&
        isEditableTarget(event.target) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      )
        continue;
      if (!matchesBinding(shortcut.binding, event, isMac)) continue;
      if (isDialogOpen()) return;

      event.preventDefault();
      if (typeof handler === 'function') handler(event);
      else if (!event.repeat && !held.has(shortcut.id)) {
        held.set(shortcut.id, { event, release: handler.release });
        handler.press(event);
      }
      return;
    }
  });

  const offKeyup = on(
    window,
    'keyup',
    (event) => {
      for (const [id, press] of held) {
        const start = press.event;
        const releasedKey =
          start.code && event.code
            ? event.code === start.code
            : event.key.toLowerCase() === start.key.toLowerCase();
        if (
          releasedKey ||
          (start.ctrlKey && !event.ctrlKey) ||
          (start.metaKey && !event.metaKey) ||
          (start.altKey && !event.altKey) ||
          (start.shiftKey && !event.shiftKey)
        ) {
          held.delete(id);
          press.release();
        }
      }
    },
    { capture: true }
  );
  const offBlur = on(window, 'blur', releaseAll);
  const offVisibility = on(document, 'visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  return () => {
    offKeydown();
    offKeyup();
    offBlur();
    offVisibility();
    releaseAll();
  };
}
