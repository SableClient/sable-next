import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';

import { activeQuery, type AutocompleteQuery } from '../autocomplete';
import { composerSchema } from './schema';

export const queryKey = new PluginKey<AutocompleteQuery | null>('composer-autocomplete');

function readQuery(state: EditorState): AutocompleteQuery | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  if (composerSchema.marks.code.isInSet(state.storedMarks ?? $from.marks())) return null;

  const start = $from.start();
  const text = state.doc.textBetween(start, $from.pos, '\n', '\n');
  const query = activeQuery(text, text.length);
  if (!query) return null;
  if (
    query.sigil === '+:' &&
    ($from.depth !== 1 ||
      $from.index(0) !== 0 ||
      state.doc.textBetween(0, start + query.start, '\n', '\uFFFC').trim() !== '' ||
      state.doc.textBetween($from.pos, state.doc.content.size, '\n', '\uFFFC').trim() !== '')
  )
    return null;

  return { ...query, start: start + query.start, end: $from.pos };
}

export function queryPlugin(): Plugin<AutocompleteQuery | null> {
  return new Plugin<AutocompleteQuery | null>({
    key: queryKey,
    state: {
      init: (_config, state) => readQuery(state),
      apply: (_tr, _value, _old, state) => readQuery(state),
    },
  });
}
