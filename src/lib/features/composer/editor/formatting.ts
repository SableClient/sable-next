import { toggleMark } from 'prosemirror-commands';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import type { MarkType } from 'prosemirror-model';
import { liftListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import type { Command, EditorState, Plugin } from 'prosemirror-state';
import { wrapIn } from 'prosemirror-commands';

import { composerSchema } from './schema';

const nodes = composerSchema.nodes;
const marks = composerSchema.marks;

function markRule(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[1];
    if (text === '') return null;

    const tr = state.tr.replaceWith(start, end, composerSchema.text(text));
    return tr.addMark(start, start + text.length, type.create()).removeStoredMark(type);
  });
}

export function formattingRules(): Plugin {
  return inputRules({
    rules: [
      markRule(/\*\*([^*]+)\*\*$/, marks.strong),
      markRule(/(?<!\*)\*([^*]+)\*$/, marks.em),
      markRule(/_([^_]+)_$/, marks.em),
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

export type FormatAction = 'strong' | 'em' | 'strike' | 'code' | 'bullet_list' | 'blockquote';

export const formatCommands: Record<FormatAction, Command> = {
  strong: toggleMark(marks.strong),
  em: toggleMark(marks.em),
  strike: toggleMark(marks.strike),
  code: toggleMark(marks.code),
  bullet_list: wrapInList(nodes.bullet_list),
  blockquote: wrapIn(nodes.blockquote),
};

export function activeMarks(state: EditorState): FormatAction[] {
  const { from, $from, to, empty } = state.selection;
  const names: FormatAction[] = ['strong', 'em', 'strike', 'code'];

  return names.filter((name) => {
    const type = marks[name];
    return empty
      ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
      : state.doc.rangeHasMark(from, to, type);
  });
}
