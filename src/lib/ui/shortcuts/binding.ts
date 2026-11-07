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
  code: string;
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

const NUMPAD_KEYS: Record<string, string> = {
  Numpad0: 'num0',
  Numpad1: 'num1',
  Numpad2: 'num2',
  Numpad3: 'num3',
  Numpad4: 'num4',
  Numpad5: 'num5',
  Numpad6: 'num6',
  Numpad7: 'num7',
  Numpad8: 'num8',
  Numpad9: 'num9',
  NumpadDecimal: 'numdec',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
};

export function isNumpadEvent(event: KeyboardEventLike): boolean {
  return event.code in NUMPAD_KEYS;
}

function eventKey(event: KeyboardEventLike): string {
  return NUMPAD_KEYS[event.code] ?? event.key.toLowerCase();
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
  if (parsed.shift && !event.shiftKey) return false;

  return eventKey(event) === parsed.key;
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
  return root.querySelector('.dialog-content, [role="dialog"]') !== null;
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
}

export function findShortcutConflicts(
  candidates: readonly ConflictCandidate[],
  isMac: boolean
): Array<[ConflictCandidate, ConflictCandidate]> {
  const conflicts: Array<[ConflictCandidate, ConflictCandidate]> = [];

  for (const [i, a] of candidates.entries()) {
    for (const b of candidates.slice(i + 1)) {
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
  numdec: 'Num .',
  numadd: 'Num +',
  numsub: 'Num -',
  nummult: 'Num *',
  numdiv: 'Num /',
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
    (parsed.key.length === 1
      ? parsed.key.toUpperCase()
      : parsed.key.replace(/^num(\d)$/, 'Num $1'));
  parts.push(keyName);

  return parts.join('+');
}

const PROSEMIRROR_KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  escape: 'Escape',
};

export function toProseMirrorKey(binding: string): string {
  const parsed = parseBinding(binding);
  const parts: string[] = [];

  if (parsed.mod) parts.push('Mod');
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.meta) parts.push('Meta');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  parts.push(
    PROSEMIRROR_KEY_NAMES[parsed.key] ??
      (parsed.key.length === 1
        ? parsed.key
        : parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1))
  );

  return parts.join('-');
}

const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift', 'os', 'altgraph']);

export function bindingFromEvent(event: KeyboardEventLike, isMac: boolean): string | null {
  const key = eventKey(event);
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
