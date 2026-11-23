import { isComposingKey, isDialogOpen, isEditableTarget } from '#lib/ui/shortcuts/binding.js';

export const MENU_SELECTOR = '[role="menu"], [role="listbox"]';

function isPaste(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey) && !event.altKey;
}

export function shouldFocusComposer(event: KeyboardEvent): boolean {
  if (typeof event.key !== 'string' || event.key.length !== 1 || event.key === ' ') return false;
  if (isComposingKey(event)) return false;
  if (!isPaste(event) && (event.ctrlKey || event.metaKey || event.altKey)) return false;
  if (isEditableTarget(event.target)) return false;

  return !isDialogOpen() && document.querySelector(MENU_SELECTOR) === null;
}
