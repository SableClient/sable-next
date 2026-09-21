import type { MarkdownIt } from 'markdown-it';
import { InputRule } from 'prosemirror-inputrules';
import type { NodeType } from 'prosemirror-model';

import { parseMfmColor, parseMfmUnixtime, utcFallbackLabel } from '../time-markup';

export function mfmTimeInputRule(type: NodeType): InputRule {
  return new InputRule(/\$\[unixtime[ \t]+\d+\]$/u, (state, match, start, end) => {
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

export function mfmPlugin(markdown: MarkdownIt): void {
  markdown.inline.ruler.before('emphasis', 'mfm', (state, silent) => {
    const slice = state.src.slice(state.pos);
    const unix = parseMfmUnixtime(slice);
    if (unix) {
      if (!silent) {
        const token = state.push('mfm_time', '', 0);
        token.content = unix.datetime;
      }
      state.pos += unix.raw.length;
      return true;
    }

    const color = parseMfmColor(slice);
    if (!color) return false;
    if (!silent) {
      if (color.args.fg) {
        const open = state.push('mfm_fg_open', 'span', 1);
        open.attrSet('value', color.args.fg);
      }
      if (color.args.bg) {
        const open = state.push('mfm_bg_open', 'span', 1);
        open.attrSet('value', color.args.bg);
      }
      state.md.inline.parse(color.text, state.md, state.env, state.tokens);
      if (color.args.bg) state.push('mfm_bg_close', 'span', -1);
      if (color.args.fg) state.push('mfm_fg_close', 'span', -1);
    }
    state.pos += color.raw.length;
    return true;
  });
}
