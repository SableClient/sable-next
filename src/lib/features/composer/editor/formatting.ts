import { chainCommands, lift, setBlockType, toggleMark } from 'prosemirror-commands';
import { InputRule, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import type { MarkType, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import type { Command, EditorState } from 'prosemirror-state';
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

export const formattingInputRules: readonly InputRule[] = [
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
];

function isHeading(state: EditorState, level: number): boolean {
  const { parent } = state.selection.$from;
  return parent.type === nodes.heading && parent.attrs.level === level;
}

function headingCommand(level: number): Command {
  return (state, dispatch) =>
    isHeading(state, level)
      ? setBlockType(nodes.paragraph)(state, dispatch)
      : setBlockType(nodes.heading, { level })(state, dispatch);
}

const codeBlockCommand: Command = (state, dispatch) =>
  state.selection.$from.parent.type === nodes.code_block
    ? setBlockType(nodes.paragraph)(state, dispatch)
    : setBlockType(nodes.code_block)(state, dispatch);

export const formattingKeymap: Record<string, Command> = {
  'Mod-b': toggleMark(marks.strong),
  'Mod-i': toggleMark(marks.em),
  'Mod-u': toggleMark(marks.underline),
  'Mod-Shift-x': toggleMark(marks.strike),
  'Mod-e': toggleMark(marks.code),
  'Mod-h': toggleMark(marks.spoiler),
  'Mod-Shift-8': wrapInList(nodes.bullet_list),
  'Mod-Shift-9': wrapInList(nodes.ordered_list),
  'Mod-Shift-.': wrapIn(nodes.blockquote),
  'Mod-1': headingCommand(1),
  'Mod-2': headingCommand(2),
  'Mod-3': headingCommand(3),
  'Mod-;': codeBlockCommand,
  'Shift-Tab': liftListItem(nodes.list_item),
};

export const splitListEntry = splitListItem(nodes.list_item);
export const sinkListEntry = sinkListItem(nodes.list_item);

export type FormatAction =
  | 'strong'
  | 'em'
  | 'underline'
  | 'strike'
  | 'code'
  | 'spoiler'
  | 'bullet_list'
  | 'ordered_list'
  | 'blockquote'
  | 'code_block'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'link';

export const formatCommands: Record<Exclude<FormatAction, 'link'>, Command> = {
  strong: toggleMark(marks.strong),
  em: toggleMark(marks.em),
  underline: toggleMark(marks.underline),
  strike: toggleMark(marks.strike),
  code: toggleMark(marks.code),
  spoiler: toggleMark(marks.spoiler),
  bullet_list: chainCommands(wrapInList(nodes.bullet_list), liftListItem(nodes.list_item)),
  ordered_list: chainCommands(wrapInList(nodes.ordered_list), liftListItem(nodes.list_item)),
  blockquote: chainCommands(wrapIn(nodes.blockquote), lift),
  code_block: codeBlockCommand,
  heading1: headingCommand(1),
  heading2: headingCommand(2),
  heading3: headingCommand(3),
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
  const names = ['strong', 'em', 'underline', 'strike', 'code', 'spoiler', 'link'] as const;

  const active: FormatAction[] = names.filter((name) => {
    const type = marks[name];
    return empty
      ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
      : state.doc.rangeHasMark(from, to, type);
  });

  if (isInside(state, nodes.bullet_list)) active.push('bullet_list');
  if (isInside(state, nodes.ordered_list)) active.push('ordered_list');
  if (isInside(state, nodes.blockquote)) active.push('blockquote');
  if ($from.parent.type === nodes.code_block) active.push('code_block');
  if (isHeading(state, 1)) active.push('heading1');
  if (isHeading(state, 2)) active.push('heading2');
  if (isHeading(state, 3)) active.push('heading3');
  return active;
}
