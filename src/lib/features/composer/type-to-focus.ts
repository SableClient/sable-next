import { isDialogOpen, isEditableTarget } from '#lib/ui/shortcuts/binding.js';

const MENU_SELECTOR = '[role="menu"], [role="listbox"]';

export function shouldFocusComposer(event: KeyboardEvent): boolean {
  if (event.key.length !== 1 || event.key === ' ') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isEditableTarget(event.target)) return false;

  return !isDialogOpen() && document.querySelector(MENU_SELECTOR) === null;
}
