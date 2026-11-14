import { afterEach, expect, test, vi } from 'vitest';

const pointer = vi.hoisted(() => ({ coarse: false }));
const keyboard = vi.hoisted((): { shown: boolean | null } => ({ shown: false }));
const CoarsePointerQuery = vi.hoisted(
  () =>
    class {
      get current() {
        return pointer.coarse;
      }
    }
);

vi.mock('svelte/reactivity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MediaQuery: CoarsePointerQuery,
}));
vi.mock('#lib/platform/keyboard.js', () => ({
  softwareKeyboardShown: () => keyboard.shown,
}));

import { enterInsertsNewline, noteKeyboardInput } from './enter-key.svelte.js';
import { preferences } from './preferences.svelte.js';

const key = (code: string) => ({ code }) as KeyboardEvent;

afterEach(() => {
  preferences.enterForNewline = 'adaptive';
  keyboard.shown = false;
  noteKeyboardInput(key(''));
});

test.each([
  ['adaptive', true, true],
  ['adaptive', false, false],
  ['newline', false, true],
  ['send', true, false],
] as const)('%s with a coarse pointer=%s inserts a newline=%s', (mode, coarse, expected) => {
  pointer.coarse = coarse;
  preferences.enterForNewline = mode;
  expect(enterInsertsNewline()).toBe(expected);
});

test.each([
  ['Enter', false, false],
  ['KeyA', false, false],
  ['', false, true],
  ['Unidentified', false, true],
  ['Enter', true, true],
  ['Enter', null, true],
] as const)(
  'adaptive on a touch device after a %s key with the on-screen keyboard shown=%s inserts a newline=%s',
  (code, shown, expected) => {
    pointer.coarse = true;
    keyboard.shown = shown;
    noteKeyboardInput(key(code));
    expect(enterInsertsNewline()).toBe(expected);
  }
);

test('a physical keyboard does not override the newline setting', () => {
  pointer.coarse = true;
  preferences.enterForNewline = 'newline';
  noteKeyboardInput(key('Enter'));
  expect(enterInsertsNewline()).toBe(true);
});
