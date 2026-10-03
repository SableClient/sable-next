import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
import { preferences } from './preferences.svelte.js';

let coarsePointer: ReturnType<typeof createMediaQuery> | undefined;

export function enterInsertsNewline(): boolean {
  const mode = preferences.enterForNewline;
  if (mode !== 'adaptive') return mode === 'newline';
  coarsePointer ??= createMediaQuery('(pointer: coarse)');
  return coarsePointer.matches;
}
