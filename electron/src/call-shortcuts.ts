import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  DesktopCallShortcut,
  DesktopCallShortcutBackend,
  DesktopCallShortcutEvent,
} from '../../src/lib/platform/call-shortcut-types';
import { parseBinding } from '../../src/lib/ui/shortcuts/binding';

interface NativeHandle {
  close(): void;
}
interface NativeModule {
  NativeCallShortcuts: new (
    bindings: ReturnType<typeof nativeBinding>[],
    backend: DesktopCallShortcutBackend,
    appId: string,
    notify: (json: string) => void
  ) => NativeHandle;
}

const KEY_NAMES: Record<string, [string, string, string]> = {
  ' ': ['Space', 'space', 'space'],
  arrowup: ['ArrowUp', 'Up', 'up'],
  arrowdown: ['ArrowDown', 'Down', 'down'],
  arrowleft: ['ArrowLeft', 'Left', 'left'],
  arrowright: ['ArrowRight', 'Right', 'right'],
  escape: ['Escape', 'Escape', 'escape'],
  enter: ['Enter', 'Return', 'return'],
  pageup: ['PageUp', 'Page_Up', 'pageup'],
  pagedown: ['PageDown', 'Page_Down', 'pagedown'],
  capslock: ['CapsLock', 'Caps_Lock', 'capslock'],
  backspace: ['Backspace', 'BackSpace', 'backspace'],
  numdec: ['NumpadDecimal', 'KP_Decimal', 'keypaddecimal'],
  numadd: ['NumpadAdd', 'KP_Add', 'keypadplus'],
  numsub: ['NumpadSubtract', 'KP_Subtract', 'keypadminus'],
  nummult: ['NumpadMultiply', 'KP_Multiply', 'keypadmultiply'],
  numdiv: ['NumpadDivide', 'KP_Divide', 'keypaddivide'],
  ';': ['Semicolon', 'semicolon', ';'],
  '=': ['Equal', 'equal', '='],
  ',': ['Comma', 'comma', ','],
  '-': ['Minus', 'minus', '-'],
  '.': ['Period', 'period', '.'],
  '/': ['Slash', 'slash', '/'],
  '`': ['Backquote', 'grave', '`'],
  '[': ['BracketLeft', 'bracketleft', '['],
  '\\': ['Backslash', 'backslash', '\\'],
  ']': ['BracketRight', 'bracketright', ']'],
  "'": ['Quote', 'apostrophe', "'"],
};

export function nativeBinding(binding: DesktopCallShortcut, isMac: boolean) {
  const parsed = parseBinding(binding.binding);
  const modifiers: string[] = [];
  if (parsed.ctrl || (parsed.mod && !isMac)) modifiers.push('CTRL');
  if (parsed.meta || (parsed.mod && isMac)) modifiers.push('SUPER');
  if (parsed.alt) modifiers.push('ALT');
  if (parsed.shift) modifiers.push('SHIFT');
  const [key, trigger, passive] =
    KEY_NAMES[parsed.key] ??
    (/^num\d$/.test(parsed.key)
      ? [
          `Numpad${parsed.key.slice(3)}`,
          `KP_${parsed.key.slice(3)}`,
          `keypad${parsed.key.slice(3)}`,
        ]
      : [
          parsed.key,
          /^f\d+$/.test(parsed.key) ? parsed.key.toUpperCase() : parsed.key,
          parsed.key,
        ]);
  return {
    id: binding.id,
    description: binding.description,
    hotkey: [...modifiers, key].join('+'),
    passive: [...modifiers, passive].join('+'),
    trigger: [...modifiers, trigger].join('+'),
  };
}

export function validBindings(value: unknown): value is DesktopCallShortcut[] {
  if (!Array.isArray(value) || value.length > 2) return false;
  const ids = new Set<string>();
  return value.every((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const binding = item as Record<string, unknown>;
    if ((binding.id !== 'talk' && binding.id !== 'mute') || ids.has(binding.id)) return false;
    ids.add(binding.id);
    return (
      typeof binding.binding === 'string' &&
      binding.binding.length > 0 &&
      binding.binding.length <= 100 &&
      typeof binding.description === 'string' &&
      binding.description.length <= 200
    );
  });
}

export class CallShortcuts {
  #handle: NativeHandle | undefined;
  #generation = 0;
  #pressed = new Set<'talk' | 'mute'>();
  #bindings: DesktopCallShortcut[] = [];
  #platform = '';
  #wayland = false;
  #appId = '';
  #focused = false;
  backend: DesktopCallShortcutBackend | undefined;

  constructor(
    readonly send: (event: DesktopCallShortcutEvent) => void,
    readonly load: () => NativeModule = () =>
      createRequire(join(__dirname, 'main.cjs'))(join(__dirname, 'sable_node.node')) as NativeModule
  ) {}

  configure(
    bindings: DesktopCallShortcut[],
    platform: string,
    wayland: boolean,
    appId: string
  ): void {
    this.stop();
    this.#bindings = bindings;
    this.#platform = platform;
    this.#wayland = wayland;
    this.#appId = appId;
    if (bindings.length > 0) this.#start();
  }

  setFocused(focused: boolean): void {
    if (this.#focused === focused) return;
    this.#focused = focused;
    if (this.backend !== 'exclusive') return;
    if (focused) this.#close();
    else this.#start();
  }

  stop(): void {
    this.#close();
    this.#bindings = [];
    this.backend = undefined;
  }

  releaseAll(): void {
    for (const id of this.#pressed) this.send({ id, pressed: false });
    this.#pressed.clear();
  }

  #start(): void {
    try {
      this.#open('passive');
      return;
    } catch (error) {
      console.debug('[sable call] passive shortcuts unavailable', error);
    }
    const backend = this.#wayland ? 'portal' : 'exclusive';
    this.backend = backend;
    if (backend === 'exclusive' && this.#focused) {
      this.send({ status: 'ready', backend });
      return;
    }
    try {
      this.#open(backend);
    } catch (error) {
      console.warn('[sable call] desktop shortcuts unavailable', error);
      this.stop();
      this.send({ status: 'error' });
    }
  }

  #open(backend: DesktopCallShortcutBackend): void {
    const generation = this.#generation;
    const { NativeCallShortcuts } = this.load();
    this.#handle = new NativeCallShortcuts(
      this.#bindings.map((b) => nativeBinding(b, this.#platform === 'darwin')),
      backend,
      this.#appId,
      (json) => {
        if (generation !== this.#generation) return;
        const event = JSON.parse(json) as DesktopCallShortcutEvent;
        if ('status' in event) {
          if (event.status === 'ready') {
            this.send({ status: 'ready', backend });
            return;
          }
          console.warn('[sable call] desktop shortcuts unavailable', event.error);
          this.stop();
          this.send(event);
          return;
        }
        if (event.pressed && this.#focused && backend !== 'portal') return;
        if (this.#pressed.has(event.id) === event.pressed) return;
        if (event.pressed) this.#pressed.add(event.id);
        else this.#pressed.delete(event.id);
        this.send({ id: event.id, pressed: event.pressed });
      }
    );
    this.backend = backend;
    if (backend !== 'portal') this.send({ status: 'ready', backend });
  }

  #close(): void {
    ++this.#generation;
    this.#handle?.close();
    this.#handle = undefined;
    this.releaseAll();
  }
}
