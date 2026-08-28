import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';

import { activeQuery, type AutocompleteQuery } from '../autocomplete';

export const queryKey = new PluginKey<AutocompleteQuery | null>('composer-autocomplete');

function readQuery(state: EditorState): AutocompleteQuery | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;

  const start = $from.start();
  const text = state.doc.textBetween(start, $from.pos, ' ', ' ');
  const query = activeQuery(text, text.length);
  if (!query) return null;

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
