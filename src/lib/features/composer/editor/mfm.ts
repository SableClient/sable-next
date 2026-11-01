import { InputRule } from 'prosemirror-inputrules';
import type { NodeType } from 'prosemirror-model';

import { parseMfmUnixtime, utcFallbackLabel } from '../time-markup';

export function mfmTimeInputRule(type: NodeType): InputRule {
  return new InputRule(/\$\[unixtime[ \t]+[^\]\s]+\]$/u, (state, match, start, end) => {
    const parsed = parseMfmUnixtime(match[0]);
    if (!parsed) return null;

    const marks = state.storedMarks ?? state.selection.$from.marks();
    return state.tr.replaceWith(
      start,
      end,
      type.create(
        { datetime: parsed.datetime, label: utcFallbackLabel(parsed.datetime) },
        null,
        marks
      )
    );
  });
}
