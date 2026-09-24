import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';

import type { FormatAction } from './formatting';
import { composerSchema } from './schema';
import { atomText } from './serialize';

const WRAPS = {
  strong: '**',
  em: '*',
  strike: '~~',
  code: '`',
  spoiler: '||',
} as const satisfies Partial<Record<FormatAction, string>>;

const PREFIXES = {
  bullet_list: '- ',
  ordered_list: '1. ',
  blockquote: '> ',
  heading1: '# ',
  heading2: '## ',
  heading3: '### ',
} as const satisfies Partial<Record<FormatAction, string>>;

const SNIPPETS = {
  horizontal_rule: '---',
  table: '|  |  |\n| --- | --- |\n|  |  |',
} as const satisfies Partial<Record<FormatAction, string>>;

function inlineLines(text: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (index > 0) nodes.push(composerSchema.nodes.hard_break.create());
    if (line !== '') nodes.push(composerSchema.text(line));
  }
  return nodes;
}

function lineStarts(state: EditorState): number[] {
  const { from, to } = state.selection;
  const starts: number[] = [];
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return true;
    let start = position + 1;
    node.forEach((child, offset) => {
      const after = position + 1 + offset + child.nodeSize;
      if (child.type !== composerSchema.nodes.hard_break) return;
      if (after - 1 >= from && start <= to) starts.push(start);
      start = after;
    });
    if (start <= to) starts.push(start);
    return false;
  });
  return starts;
}

function atLineStart(state: EditorState, position: number): boolean {
  const $position = state.doc.resolve(position);
  return (
    $position.parentOffset === 0 || $position.nodeBefore?.type === composerSchema.nodes.hard_break
  );
}

function wrap(marker: string): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const size = state.doc.content.size;
    const text = (start: number, end: number): string =>
      state.doc.textBetween(Math.max(0, start), Math.min(size, end));
    const wrapped =
      text(from - marker.length, from) === marker &&
      text(to, to + marker.length) === marker &&
      !text(from - marker.length - 1, from - marker.length).endsWith(marker[0]) &&
      !text(to + marker.length, to + marker.length + 1).startsWith(marker[0]);
    if (!dispatch) return true;

    const tr = state.tr;
    if (wrapped) {
      tr.delete(to, to + marker.length).delete(from - marker.length, from);
      tr.setSelection(TextSelection.create(tr.doc, from - marker.length, to - marker.length));
    } else {
      tr.insertText(marker, to).insertText(marker, from);
      tr.setSelection(TextSelection.create(tr.doc, from + marker.length, to + marker.length));
    }
    dispatch(tr);
    return true;
  };
}

function prefix(marker: string): Command {
  return (state, dispatch) => {
    const starts = lineStarts(state);
    if (starts.length === 0) return false;
    if (!dispatch) return true;

    const prefixed = (start: number) =>
      state.doc.textBetween(start, Math.min(start + marker.length, state.doc.content.size)) ===
      marker;
    const removing = starts.every(prefixed);
    const tr = state.tr;
    for (const start of [...starts].reverse()) {
      if (removing) tr.delete(start, start + marker.length);
      else if (!prefixed(start)) tr.insertText(marker, start);
    }
    dispatch(tr);
    return true;
  };
}

function block(text: string, caretLine: number | null): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const { from, to } = state.selection;
    const lead = atLineStart(state, from) ? '' : '\n';
    const nodes = inlineLines(`${lead}${text}\n`);
    const tr = state.tr.replaceWith(from, to, nodes);
    if (caretLine !== null) {
      let caret = from;
      let line = lead === '' ? 0 : -1;
      for (const node of nodes) {
        if (line === caretLine) break;
        caret += node.nodeSize;
        if (node.type === composerSchema.nodes.hard_break) line += 1;
      }
      tr.setSelection(TextSelection.create(tr.doc, caret));
    }
    dispatch(tr);
    return true;
  };
}

const codeBlock: Command = (state, dispatch, view) => {
  const { from, to, empty } = state.selection;
  const selected = state.doc.textBetween(from, to, '\n', (node) =>
    node.type === composerSchema.nodes.hard_break ? '\n' : atomText(node)
  );
  return block(empty ? '```\n\n```' : `\`\`\`\n${selected}\n\`\`\``, empty ? 1 : null)(
    state,
    dispatch,
    view
  );
};

export const markdownFormatCommands: Partial<Record<FormatAction, Command>> = {
  ...Object.fromEntries(Object.entries(WRAPS).map(([action, marker]) => [action, wrap(marker)])),
  ...Object.fromEntries(
    Object.entries(PREFIXES).map(([action, marker]) => [action, prefix(marker)])
  ),
  ...Object.fromEntries(
    Object.entries(SNIPPETS).map(([action, text]) => [action, block(text, null)])
  ),
  code_block: codeBlock,
};

export const MARKDOWN_FORMATS: readonly FormatAction[] = [
  ...(Object.keys(markdownFormatCommands) as FormatAction[]),
  'link',
];

export function markdownLink(state: EditorState, href: string): ProseMirrorNode {
  const { from, to, empty } = state.selection;
  const label = empty ? href : state.doc.textBetween(from, to, ' ', ' ');
  return composerSchema.text(`[${label}](${href})`);
}
