import { chainCommands, lift, toggleMark } from 'prosemirror-commands';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import type { MarkType, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import type { Command, EditorState, Plugin } from 'prosemirror-state';
import { wrapIn } from 'prosemirror-commands';

import { composerSchema } from './schema';

const nodes = composerSchema.nodes;
const marks = composerSchema.marks;

function markRule(pattern: RegExp, type: MarkType): InputRule {
  /* `inCodeMark` defaults to true, so without this every rule still fires
     inside an inline code span. `MarkSpec.code` is what it keys off. */
  return new InputRule(
    pattern,
    (state, match, start, end) => {
      const text = match[1];
      if (text === '') return null;

      /* Cut the delimiters rather than rebuilding the range as fresh text, or
         the marks already inside it are lost: `**a ~~b~~ c**` drops the strike.
         The closing delimiter is only partly in the document — the character
         that triggered the rule has not been inserted yet. */
      const delimiter = (match[0].length - text.length) / 2;
      const tr = state.tr
        .delete(start + delimiter + text.length, end)
        .delete(start, start + delimiter);
      return tr.addMark(start, start + text.length, type.create()).removeStoredMark(type);
    },
    { inCodeMark: false }
  );
}

export function formattingRules(): Plugin {
  return inputRules({
    rules: [
      markRule(/\*\*([^*]+)\*\*$/, marks.strong),
      markRule(/(?<!\*)\*([^*]+)\*$/, marks.em),
      markRule(/(?<![\p{L}\p{N}_])_([^_]+)_$/u, marks.em),
      markRule(/~~([^~]+)~~$/, marks.strike),
      markRule(/`([^`]+)`$/, marks.code),
      textblockTypeInputRule(/^(#{1,3})\s$/, nodes.heading, (match) => ({
        level: match[1].length,
      })),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1])
      ),
      textblockTypeInputRule(/^```$/, nodes.code_block),
    ],
  });
}

export const formattingKeymap: Record<string, Command> = {
  'Mod-b': toggleMark(marks.strong),
  'Mod-i': toggleMark(marks.em),
  'Mod-Shift-x': toggleMark(marks.strike),
  'Mod-e': toggleMark(marks.code),
  'Mod-Shift-8': wrapInList(nodes.bullet_list),
  'Mod-Shift-9': wrapInList(nodes.ordered_list),
  'Mod-Shift-.': wrapIn(nodes.blockquote),
  'Shift-Tab': liftListItem(nodes.list_item),
};

export const splitListEntry = splitListItem(nodes.list_item);
export const sinkListEntry = sinkListItem(nodes.list_item);

export type FormatAction = 'strong' | 'em' | 'strike' | 'code' | 'bullet_list' | 'blockquote';

export const formatCommands: Record<FormatAction, Command> = {
  strong: toggleMark(marks.strong),
  em: toggleMark(marks.em),
  strike: toggleMark(marks.strike),
  code: toggleMark(marks.code),
  bullet_list: chainCommands(wrapInList(nodes.bullet_list), liftListItem(nodes.list_item)),
  blockquote: chainCommands(wrapIn(nodes.blockquote), lift),
};

function isInside(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === type) return true;
  }
  return false;
}

export function activeMarks(state: EditorState): FormatAction[] {
  const { from, $from, to, empty } = state.selection;
  const names = ['strong', 'em', 'strike', 'code'] as const;

  const active: FormatAction[] = names.filter((name) => {
    const type = marks[name];
    return empty
      ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
      : state.doc.rangeHasMark(from, to, type);
  });

  if (isInside(state, nodes.bullet_list)) active.push('bullet_list');
  if (isInside(state, nodes.blockquote)) active.push('blockquote');
  return active;
}
