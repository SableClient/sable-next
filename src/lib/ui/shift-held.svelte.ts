import { on } from 'svelte/events';
import { createSubscriber } from 'svelte/reactivity';

import { isComposingKey, isEditableTarget } from './shortcuts/binding.js';

let held = false;

const shiftOnly = (event: KeyboardEvent | PointerEvent): boolean =>
  event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;

const subscribe = createSubscriber((update) => {
  // Shift types capitals in a text field, so there it may let go but never take hold.
  const set = (next: boolean, target: EventTarget | null = null): void => {
    if (next === held || (next && isEditableTarget(target))) return;
    held = next;
    update();
  };
  const key = (event: KeyboardEvent): void => {
    if (!isComposingKey(event)) set(shiftOnly(event), event.target);
  };
  // A toolbar subscribes once its row is hovered, often after Shift went down,
  // so the pointer's modifier state catches up.
  const pointer = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') set(shiftOnly(event), document.activeElement);
  };
  const offs = [
    on(window, 'keydown', key, { capture: true, passive: true }),
    on(window, 'keyup', key, { capture: true, passive: true }),
    on(window, 'pointermove', pointer, { capture: true, passive: true }),
    on(window, 'pointerover', pointer, { capture: true, passive: true }),
    on(window, 'blur', () => {
      set(false);
    }),
    on(document, 'visibilitychange', () => {
      if (document.hidden) set(false);
    }),
  ];
  return () => {
    held = false;
    for (const off of offs) off();
  };
});

/** Whether Shift alone is held down, outside text fields. */
export function shiftHeld(): boolean {
  subscribe();
  return held;
}
