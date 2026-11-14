import { MediaQuery } from 'svelte/reactivity';
import { softwareKeyboardShown } from '#lib/platform/keyboard.js';
import { preferences } from './preferences.svelte.js';

let coarsePointer: MediaQuery | undefined;
let physicalKeyboard = $state(false);

export function noteKeyboardInput(event: KeyboardEvent): void {
  physicalKeyboard =
    event.code !== '' && event.code !== 'Unidentified' && softwareKeyboardShown() === false;
}

export function enterInsertsNewline(): boolean {
  const mode = preferences.enterForNewline;
  if (mode !== 'adaptive') return mode === 'newline';
  coarsePointer ??= new MediaQuery('(pointer: coarse)');
  return coarsePointer.current && !physicalKeyboard;
}
