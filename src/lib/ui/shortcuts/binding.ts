const KEY_ALIASES: Record<string, string> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  esc: 'escape',
  space: ' ',
};

export interface ParsedBinding {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function parseBinding(binding: string): ParsedBinding {
  const tokens = binding
    .toLowerCase()
    .split('+')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const parsed: ParsedBinding = {
    key: '',
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  };

  for (const token of tokens) {
    switch (token) {
      case 'mod':
        parsed.mod = true;
        break;
      case 'control':
      case 'ctrl':
        parsed.ctrl = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        parsed.meta = true;
        break;
      case 'alt':
      case 'option':
        parsed.alt = true;
        break;
      case 'shift':
        parsed.shift = true;
        break;
      default:
        parsed.key = KEY_ALIASES[token] ?? token;
    }
  }

  return parsed;
}

function isNamedKey(key: string): boolean {
  return key.length > 1;
}

export function matchesBinding(binding: string, event: KeyboardEventLike, isMac: boolean): boolean {
  const parsed = parseBinding(binding);
  const requiredCtrl = parsed.ctrl || (parsed.mod && !isMac);
  const requiredMeta = parsed.meta || (parsed.mod && isMac);

  if (event.ctrlKey !== requiredCtrl) return false;
  if (event.metaKey !== requiredMeta) return false;
  if (event.altKey !== parsed.alt) return false;
  if (isNamedKey(parsed.key) && event.shiftKey !== parsed.shift) return false;

  return event.key.toLowerCase() === parsed.key;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function isDialogOpen(root: ParentNode = document): boolean {
  return root.querySelector('.sable-dialog-content') !== null;
}

function canonicalBinding(binding: string, isMac: boolean): string {
  const parsed = parseBinding(binding);
  const modifiers: string[] = [];
  if (parsed.ctrl || (parsed.mod && !isMac)) modifiers.push('ctrl');
  if (parsed.meta || (parsed.mod && isMac)) modifiers.push('meta');
  if (parsed.alt) modifiers.push('alt');
  if (parsed.shift) modifiers.push('shift');
  return [...modifiers, parsed.key].join('+');
}

export interface ConflictCandidate {
  id: string;
  binding: string;
  scope: string;
}

export function findShortcutConflicts(
  candidates: readonly ConflictCandidate[],
  isMac: boolean
): Array<[ConflictCandidate, ConflictCandidate]> {
  const conflicts: Array<[ConflictCandidate, ConflictCandidate]> = [];

  for (const [i, a] of candidates.entries()) {
    for (const b of candidates.slice(i + 1)) {
      if (a.scope !== b.scope) continue;
      if (canonicalBinding(a.binding, isMac) === canonicalBinding(b.binding, isMac)) {
        conflicts.push([a, b]);
      }
    }
  }

  return conflicts;
}

const DISPLAY_KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Esc',
};

export function formatBinding(binding: string, isMac: boolean): string {
  const parsed = parseBinding(binding);
  const parts: string[] = [];

  if (parsed.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.meta) parts.push(isMac ? '⌘' : 'Meta');
  if (parsed.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (parsed.shift) parts.push(isMac ? '⇧' : 'Shift');

  const keyName =
    DISPLAY_KEY_NAMES[parsed.key] ??
    (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  parts.push(keyName);

  return parts.join('+');
}

const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift', 'os', 'altgraph']);

export function bindingFromEvent(event: KeyboardEventLike, isMac: boolean): string | null {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;

  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (isMac && event.ctrlKey) parts.push('ctrl');
  if (!isMac && event.metaKey) parts.push('meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(key === ' ' ? 'space' : key);

  return parts.join('+');
}
