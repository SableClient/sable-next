import { lift, setBlockType, toggleMark } from 'prosemirror-commands';
import { InputRule, undoInputRule } from 'prosemirror-inputrules';
import { diffChars } from 'diff';
import {
  Fragment,
  type Attrs,
  type Mark,
  type MarkType,
  type Node as ProseMirrorNode,
  type NodeType,
} from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import {
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { canJoin, findWrapping } from 'prosemirror-transform';
import { wrapIn } from 'prosemirror-commands';

import { composerSchema } from './schema';
import { atomText, markdownSlice } from './serialize';

const nodes = composerSchema.nodes;
const marks = composerSchema.marks;

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function inlineMarkdownRule(): InputRule {
  const delimiterMarks: Record<string, MarkType> = {
    ')': marks.link,
    '`': marks.code,
    '~': marks.strike,
    '|': marks.spoiler,
  };
  return new InputRule(/[\s\S]+$/, (state, match, start, end) => {
    const stored = state.storedMarks ?? state.selection.$from.marks();
    if (stored.some((mark) => mark.type === marks.code)) return null;
    if (
      match[0].length > end - start &&
      match[0].endsWith('`') &&
      marks.code.isInSet(state.selection.$from.nodeBefore?.marks ?? [])
    ) {
      let reverted: Transaction | undefined;
      undoInputRule(state, (tr) => {
        reverted = tr;
      });
      if (
        reverted &&
        reverted.doc.textBetween(reverted.selection.from - 1, reverted.selection.from) === '`'
      ) {
        return reverted.insertText('`');
      }
    }
    const $end = state.doc.resolve(end);
    const after = $end.parent.textBetween(
      $end.parentOffset,
      $end.parent.content.size,
      '',
      LINE_BREAK
    );
    const suffix = /^(?:\*+|_+|~+|\|+|`+)/.exec(after)?.[0] ?? '';
    if (suffix && state.doc.rangeHasMark(end, end + suffix.length, marks.code)) return null;
    const source = match[0] + suffix;
    const closing = /(?:\*+|_+|~+|\|+|`+|\))$/.exec(source)?.[0];
    if (!closing) return null;
    if (closing[0] === '_' && /[\p{L}\p{N}_]/u.test(after[suffix.length] ?? '')) return null;
    const code = closing[0] === '`';
    if (!code && escaped(source, source.length - closing.length)) return null;
    const runs = Array.from(source.matchAll(/\*+|_+|~+|\|+|`+|\[/g)).filter(
      (run) =>
        !escaped(source, run.index) &&
        !state.doc.rangeHasMark(
          Math.min(end, start + run.index),
          Math.min(end, start + run.index + run[0].length),
          marks.code
        )
    );

    for (const [index, run] of runs.entries()) {
      const delimiter = run[0];
      if (run.index + delimiter.length >= source.length) continue;
      if (delimiter !== (closing === ')' ? '[' : closing)) continue;
      const prefix = runs.slice(0, index);
      if (!code && prefix.some((prior) => prior[0][0] === '`')) continue;
      if (
        prefix.some((prior) => prior[0][0] === delimiter[0] && prior[0].length > delimiter.length)
      )
        continue;
      if (delimiter[0] === '_' && /[\p{L}\p{N}_]/u.test(source[run.index - 1] ?? '')) continue;

      const raw = source.slice(run.index);
      const parsed = markdownSlice(raw);
      const first = parsed.content.firstChild;
      const expected =
        delimiterMarks[closing[0]] ?? (delimiter.length === 1 ? marks.em : marks.strong);
      if (
        !first?.isInline ||
        parsed.content.content.some(
          (node) => !expected.isInSet(node.marks) && !marks.code.isInSet(node.marks)
        )
      )
        continue;

      const from = start + run.index;
      const text = parsed.content.textBetween(0, parsed.content.size, '', LINE_BREAK);
      const positions: (number | null)[] = [];
      let offset = 0;
      for (const change of diffChars(raw, text)) {
        if (!change.removed) {
          for (let i = 0; i < change.value.length; i++) {
            positions.push(change.added ? null : from + offset + i);
          }
        }
        if (!change.added) offset += change.value.length;
      }
      const content: ProseMirrorNode[] = [];
      let position = 0;
      parsed.content.forEach((node) => {
        if (!node.isText) {
          content.push(node);
          position++;
          return;
        }
        for (const char of node.text ?? '') {
          const originalPosition = positions[position] ?? null;
          const original =
            originalPosition !== null && originalPosition < end
              ? state.doc.nodeAt(originalPosition)
              : null;
          const combined = (original?.marks ?? stored).reduce(
            (set, mark) => mark.addToSet(set),
            node.marks
          );
          content.push(
            char === LINE_BREAK && original?.isInline && !original.isText
              ? original.mark(combined)
              : composerSchema.text(char, combined)
          );
          position += char.length;
        }
      });
      return state.tr
        .replaceWith(from, end + suffix.length, Fragment.fromArray(content))
        .setStoredMarks(suffix ? (content[content.length - 1]?.marks ?? stored) : stored);
    }
    return null;
  });
}

const URL_PATTERN =
  /(?:^|[\p{White_Space}(])((?:https?:\/\/|www\.)[^\p{White_Space}\uFFFC<>()]*[^\p{White_Space}\uFFFC<>().,;:!?'"])[.,;:!?'"]*([\p{White_Space})\uFFFC])$/u;

const URL_AT_CURSOR =
  /(?:^|[\p{White_Space}(])((?:https?:\/\/|www\.)[^\p{White_Space}<>()]*[^\p{White_Space}<>().,;:!?'"])[.,;:!?'"]*$/u;

const LINE_BREAK = '\uFFFC';

type LineHandler = (
  tr: Transaction,
  match: RegExpMatchArray,
  start: number,
  end: number
) => boolean;

function lineRule(pattern: RegExp, handler: LineHandler): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const tr = state.tr;
    if (match[0].startsWith(LINE_BREAK)) {
      if (state.doc.nodeAt(start)?.type !== nodes.hard_break) return null;
      tr.delete(start, start + 1).split(start);
      const offset = tr.mapping.map(start, 1) - start;
      start += offset;
      end += offset - 1;
    }
    return handler(tr, match, start, end) ? tr : null;
  });
}

function lineTextblockRule(
  pattern: RegExp,
  type: NodeType,
  getAttrs: (match: RegExpMatchArray) => Attrs
): InputRule {
  return lineRule(pattern, (tr, match, start, end) => {
    const $start = tr.doc.resolve(start);
    if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), type))
      return false;
    tr.delete(start, end).setBlockType(start, start, type, getAttrs(match));
    return true;
  });
}

function lineWrappingRule(
  pattern: RegExp,
  type: NodeType,
  getAttrs?: (match: RegExpMatchArray) => Attrs,
  joinPredicate?: (match: RegExpMatchArray, node: ProseMirrorNode) => boolean
): InputRule {
  return lineRule(pattern, (tr, match, start, end) => {
    tr.delete(start, end);
    const $start = tr.doc.resolve(start);
    if (type === nodes.blockquote && $start.node(-1).type === type) return true;
    if (
      $start.depth > 2 &&
      $start.node(-1).type === nodes.list_item &&
      $start.node(-2).type === type &&
      $start.index(-1) > 0
    ) {
      tr.split($start.before());
      return true;
    }
    if (
      $start.depth > 2 &&
      $start.node(-1).type === nodes.list_item &&
      $start.node(-2).type === type &&
      $start.index(-1) === 0 &&
      $start.index(-2) > 0 &&
      $start.parent.content.size === 0
    ) {
      return true;
    }
    const range = $start.blockRange();
    const wrapping = range && findWrapping(range, type, getAttrs?.(match));
    if (!range || !wrapping) return false;
    tr.wrap(range, wrapping);
    const before = tr.doc.resolve(start - 1).nodeBefore;
    if (
      before?.type === type &&
      canJoin(tr.doc, start - 1) &&
      (!joinPredicate || joinPredicate(match, before))
    ) {
      tr.join(start - 1);
    }
    return true;
  });
}

export const formattingInputRules: readonly InputRule[] = [
  inlineMarkdownRule(),
  lineTextblockRule(/(?:^|\uFFFC)(#{1,3})\s$/, nodes.heading, (match) => ({
    level: match[1].length,
  })),
  lineTextblockRule(/(?:^|\uFFFC)-#\s$/, nodes.subtext, () => ({})),
  lineWrappingRule(/(?:^|\uFFFC)\s*>\s$/, nodes.blockquote),
  lineWrappingRule(/(?:^|\uFFFC)\s*([-+*])\s$/, nodes.bullet_list),
  lineWrappingRule(
    /(?:^|\uFFFC)(\d+)\.\s$/,
    nodes.ordered_list,
    (match) => ({ order: Number(match[1]) }),
    (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1])
  ),
  autolinkRule(),
];

function autolinkRule(): InputRule {
  return new InputRule(
    URL_PATTERN,
    (state, match, start, end) => {
      const text = match[1];
      const from = start + match[0].indexOf(text);
      const to = from + text.length;
      if (from < 0 || state.doc.rangeHasMark(from, to, marks.link)) return null;

      const href = text.startsWith('www.') ? `https://${text}` : text;
      const tr = state.tr
        .addMark(from, to, marks.link.create({ href }))
        .removeStoredMark(marks.link);

      return end - start === match[0].length ? tr : tr.insertText(match[2], end);
    },
    { inCodeMark: false }
  );
}

export function autolinkAtCursor(state: EditorState): Transaction | null {
  if (!state.selection.empty) return null;
  const { $from } = state.selection;
  const text = $from.parent.textBetween(0, $from.parentOffset, '', '');
  const match = URL_AT_CURSOR.exec(text);
  const url = match?.[1];
  if (!match || !url) return null;

  const from = $from.start() + match.index + match[0].indexOf(url);
  const to = from + url.length;
  if (state.doc.rangeHasMark(from, to, marks.link)) return null;

  const href = url.startsWith('www.') ? `https://${url}` : url;
  return state.tr.addMark(from, to, marks.link.create({ href })).removeStoredMark(marks.link);
}

function isInside(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === type) return true;
  }
  return false;
}

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

const codeBlockCommand: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if ($from.parent.type === nodes.code_block) return setBlockType(nodes.paragraph)(state, dispatch);
  if (!$from.sameParent($to) || !$from.parent.isTextblock) {
    return setBlockType(nodes.code_block)(state, dispatch);
  }

  const block = $from.parent;
  const $start = state.doc.resolve($from.start());
  const codeBlock = nodes.code_block;
  if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), codeBlock)) {
    return false;
  }

  if (dispatch) {
    const leafText = (leaf: ProseMirrorNode) =>
      leaf.type === nodes.hard_break ? '\n' : atomText(leaf);
    const text = block.textBetween(0, block.content.size, undefined, leafText);
    const before = block.textBetween(0, $from.parentOffset, undefined, leafText);
    const replacement = codeBlock.create(null, text === '' ? null : composerSchema.text(text));
    const tr = state.tr.replaceWith($from.before(), $from.after(), replacement);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1 + before.length)));
  }
  return true;
};

const liftListEntry = liftListItem(nodes.list_item);

function toggleWrap(type: NodeType): Command {
  return (state, dispatch, view) =>
    isInside(state, type) ? lift(state, dispatch, view) : wrapIn(type)(state, dispatch, view);
}

function enclosingDepth(state: EditorState, type: NodeType): number | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === type) return depth;
  }
  return null;
}

function joinAdjacentList(tr: Transaction, type: NodeType): void {
  const { $from } = tr.selection;
  const depth = enclosingDepth(tr as unknown as EditorState, type);
  if (depth === null) return;
  const before = $from.before(depth);
  if (tr.doc.resolve(before).nodeBefore?.type === type && canJoin(tr.doc, before)) tr.join(before);
}

function toggleList(type: NodeType): Command {
  const other = type === nodes.bullet_list ? nodes.ordered_list : nodes.bullet_list;
  const wrap = wrapInList(type);

  return (state, dispatch, view) => {
    if (isInside(state, type)) return liftListEntry(state, dispatch, view);

    const otherDepth = enclosingDepth(state, other);
    if (otherDepth !== null) {
      if (dispatch) {
        const tr = state.tr.setNodeMarkup(state.selection.$from.before(otherDepth), type);
        joinAdjacentList(tr, type);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    return wrap(
      state,
      dispatch &&
        ((tr) => {
          joinAdjacentList(tr, type);
          dispatch(tr);
        }),
      view
    );
  };
}

export const joinListItemBackward: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.depth < 3) return false;
  if ($from.node(-1).type !== nodes.list_item || $from.index(-1) !== 0) return false;
  if ($from.index(-2) === 0) return false;

  const boundary = $from.before(-1);
  if (!canJoin(state.doc, boundary)) return false;
  if (dispatch) {
    const tr = state.tr.join(boundary);
    const inner = tr.doc.resolve(tr.mapping.map($from.before()));
    if (inner.nodeBefore?.type === inner.nodeAfter?.type && canJoin(tr.doc, inner.pos)) {
      tr.join(inner.pos);
    } else if (inner.nodeAfter?.content.size === 0) {
      tr.delete(inner.pos, inner.pos + inner.nodeAfter.nodeSize);
      tr.setSelection(Selection.near(tr.doc.resolve(inner.pos), -1));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

function canInsert(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const index = $from.index(depth);
    if ($from.node(depth).canReplaceWith(index, index, type)) return true;
  }
  return false;
}

function insertNode(type: NodeType, build: () => ProseMirrorNode | null): Command {
  return (state, dispatch) => {
    if (!canInsert(state, type)) return false;
    const node = build();
    if (!node) return false;
    dispatch?.(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

const horizontalRuleCommand = insertNode(nodes.horizontal_rule, () =>
  nodes.horizontal_rule.create()
);

const TABLE_COLUMNS = 2;
const TABLE_ROWS = 2;

function tableRow(cell: NodeType): ProseMirrorNode | null {
  const cells = Array.from({ length: TABLE_COLUMNS }, () => cell.createAndFill()).filter(
    (node): node is ProseMirrorNode => node !== null
  );
  return cells.length === TABLE_COLUMNS ? nodes.table_row.create(null, cells) : null;
}

const tableCommand = insertNode(nodes.table, () => {
  const header = tableRow(nodes.table_header);
  const body = Array.from({ length: TABLE_ROWS }, () => tableRow(nodes.table_cell));
  if (!header || body.some((row) => row === null)) return null;
  return nodes.table.create(null, [header, ...(body as ProseMirrorNode[])]);
});

const detailsCommand = insertNode(nodes.details, () => nodes.details.createAndFill());

const bulletListCommand = toggleList(nodes.bullet_list);
const orderedListCommand = toggleList(nodes.ordered_list);
const blockquoteCommand = toggleWrap(nodes.blockquote);

export const formattingKeymap: Record<string, Command> = {
  'Mod-b': toggleMark(marks.strong),
  'Mod-i': toggleMark(marks.em),
  'Mod-u': toggleMark(marks.underline),
  'Mod-Shift-x': toggleMark(marks.strike),
  'Mod-e': toggleMark(marks.code),
  'Mod-,': toggleMark(marks.sub),
  'Mod-.': toggleMark(marks.sup),
  'Mod-h': toggleMark(marks.spoiler),
  'Mod-Shift-8': bulletListCommand,
  'Mod-Shift-9': orderedListCommand,
  'Mod-Shift-.': blockquoteCommand,
  'Mod-1': headingCommand(1),
  'Mod-2': headingCommand(2),
  'Mod-3': headingCommand(3),
  'Mod-;': codeBlockCommand,
  'Shift-Tab': liftListEntry,
};

export const splitListEntry = splitListItem(nodes.list_item);
export const insideListItem = (state: EditorState): boolean => isInside(state, nodes.list_item);
export const sinkListEntry = sinkListItem(nodes.list_item);

export type FormatAction =
  | 'strong'
  | 'em'
  | 'underline'
  | 'strike'
  | 'code'
  | 'spoiler'
  | 'sub'
  | 'sup'
  | 'bullet_list'
  | 'ordered_list'
  | 'blockquote'
  | 'code_block'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'horizontal_rule'
  | 'table'
  | 'details'
  | 'link';

export const formatCommands: Record<Exclude<FormatAction, 'link'>, Command> = {
  strong: toggleMark(marks.strong),
  em: toggleMark(marks.em),
  underline: toggleMark(marks.underline),
  strike: toggleMark(marks.strike),
  code: toggleMark(marks.code),
  spoiler: toggleMark(marks.spoiler),
  sub: toggleMark(marks.sub),
  sup: toggleMark(marks.sup),
  bullet_list: bulletListCommand,
  ordered_list: orderedListCommand,
  blockquote: blockquoteCommand,
  code_block: codeBlockCommand,
  heading1: headingCommand(1),
  heading2: headingCommand(2),
  heading3: headingCommand(3),
  horizontal_rule: horizontalRuleCommand,
  table: tableCommand,
  details: detailsCommand,
};

export function activeMarks(state: EditorState): FormatAction[] {
  const { from, $from, to, empty } = state.selection;
  const names = [
    'strong',
    'em',
    'underline',
    'strike',
    'code',
    'spoiler',
    'sub',
    'sup',
    'link',
  ] as const;

  const active: FormatAction[] = names.filter((name) => {
    const type = marks[name];
    return empty
      ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
      : state.doc.rangeHasMark(from, to, type);
  });

  if (isInside(state, nodes.bullet_list)) active.push('bullet_list');
  if (isInside(state, nodes.ordered_list)) active.push('ordered_list');
  if (isInside(state, nodes.blockquote)) active.push('blockquote');
  if (isInside(state, nodes.table)) active.push('table');
  if (isInside(state, nodes.details)) active.push('details');
  if ($from.parent.type === nodes.code_block) active.push('code_block');
  if (isHeading(state, 1)) active.push('heading1');
  if (isHeading(state, 2)) active.push('heading2');
  if (isHeading(state, 3)) active.push('heading3');
  return active;
}

export type ColorKind = 'fg' | 'bg';

export interface ActiveColors {
  fg: string | null;
  bg: string | null;
}

function colorOf(state: EditorState, type: MarkType): string | null {
  const { from, to, $from, empty } = state.selection;
  const inSet = (set: readonly Mark[]) =>
    (type.isInSet(set)?.attrs.value as string | undefined) ?? null;
  if (empty) return inSet(state.storedMarks ?? $from.marks());
  let found: string | null | undefined;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const value = inSet(node.marks);
    found = found === undefined || found === value ? value : null;
  });
  return found ?? null;
}

export function activeColors(state: EditorState): ActiveColors {
  return { fg: colorOf(state, marks.color), bg: colorOf(state, marks.bg_color) };
}

export function colorCommand(kind: ColorKind, value: string | null): Command {
  const type = kind === 'fg' ? marks.color : marks.bg_color;
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) {
      tr.removeStoredMark(type);
      if (value) tr.addStoredMark(type.create({ value }));
    } else {
      tr.removeMark(from, to, type);
      if (value) tr.addMark(from, to, type.create({ value }));
    }
    dispatch(tr);
    return true;
  };
}
