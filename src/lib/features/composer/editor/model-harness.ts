import { DOMSerializer } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { preferences } from '#lib/settings/preferences.svelte.js';

import { ComposerEditor } from './composer-editor';
import { composerSchema, parseMatrixHtml } from './schema';

const CARET = '\uE001';
const ANCHOR = '\uE002';
const HEAD = '\uE003';

let dispose: (() => void) | undefined;
let sentCount = 0;

export function sent(): number {
  return sentCount;
}

export function resetModel(): void {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  sentCount = 0;
  preferences.richTextComposer = false;
}

export const view = (editor: ComposerEditor): EditorView =>
  (editor as unknown as { view: EditorView }).view;

export function cm(html: string): ComposerEditor {
  preferences.richTextComposer = true;
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x'), hold: () => () => {} },
    emotes: () => [],
    label: () => 'x',
    listboxId: 's',
    activeOptionId: () => null,
    editable: () => true,
    onSubmit: () => {
      sentCount += 1;
    },
    onChange: () => {},
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: () => {},
    onLinkRequest: () => {},
    onSpoilerRequest: () => {},
    onSourceToggle: () => {},
  });
  dispose = editor.mount(host);

  const backwards = html.includes('|{');
  const marked = (
    backwards
      ? html.replace('|{', HEAD).replace('}', ANCHOR)
      : html.replace('}|', HEAD).replace('{', ANCHOR)
  ).replace('|', CARET);
  editor.setDoc(parseMatrixHtml(marked));

  const editorView = view(editor);
  const raw = new Map<string, number>();
  const tr = editorView.state.tr;
  editorView.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    for (const marker of [CARET, ANCHOR, HEAD]) {
      const index = node.text.indexOf(marker);
      if (index === -1) continue;
      raw.set(marker, pos + index);
      const at = tr.mapping.map(pos + index);
      tr.delete(at, at + 1);
    }
    return true;
  });
  const positions = new Map(
    [...raw.entries()].map(([marker, at]) => [marker, tr.mapping.map(at, -1)] as const)
  );
  const anchor = positions.get(ANCHOR) ?? positions.get(CARET) ?? positions.get(HEAD);
  const head = positions.get(HEAD) ?? positions.get(CARET) ?? anchor;
  if (anchor === undefined || head === undefined) throw new Error(`no caret in ${html}`);
  editorView.dispatch(tr.setSelection(TextSelection.create(tr.doc, anchor, head)));
  return editor;
}

export function tx(editor: ComposerEditor): string {
  const editorView = view(editor);
  const { from, to, empty, anchor, head } = editorView.state.selection;
  const { doc } = editorView.state;
  const tr = editorView.state.tr;
  if (empty) tr.insert(from, composerSchema.text(CARET, doc.resolve(from).marks()));
  else {
    tr.insert(to, composerSchema.text(HEAD, doc.resolve(to).nodeBefore?.marks ?? []));
    tr.insert(from, composerSchema.text(ANCHOR, doc.resolve(from).nodeAfter?.marks ?? []));
  }

  const holder = document.createElement('div');
  holder.append(DOMSerializer.fromSchema(composerSchema).serializeFragment(tr.doc.content));
  return holder.innerHTML
    .replaceAll(HEAD, anchor > head ? '}' : '}|')
    .replaceAll(ANCHOR, anchor > head ? '|{' : '{')
    .replaceAll(CARET, '|')
    .replaceAll('<p></p>', '');
}

export function press(
  editor: ComposerEditor,
  key: string,
  modifiers: { shift?: boolean; mod?: boolean } = {}
): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: modifiers.shift ?? false,
    ctrlKey: modifiers.mod ?? false,
    bubbles: true,
    cancelable: true,
  });
  return view(editor).someProp('handleKeyDown', (handler) => handler(view(editor), event)) ?? false;
}

export function enter(editor: ComposerEditor): void {
  press(editor, 'Enter');
}
export function softBreak(editor: ComposerEditor): void {
  press(editor, 'Enter', { shift: true });
}
export function backspace(editor: ComposerEditor): void {
  press(editor, 'Backspace');
}
export function indent(editor: ComposerEditor): void {
  press(editor, 'Tab');
}
export function unindent(editor: ComposerEditor): void {
  press(editor, 'Tab', { shift: true });
}
export function orderedList(editor: ComposerEditor): void {
  editor.format('ordered_list');
}
export function unorderedList(editor: ComposerEditor): void {
  editor.format('bullet_list');
}
export function bold(editor: ComposerEditor): void {
  editor.format('strong');
}
export function italic(editor: ComposerEditor): void {
  editor.format('em');
}
export function strike(editor: ComposerEditor): void {
  editor.format('strike');
}
export function inlineCode(editor: ComposerEditor): void {
  editor.format('code');
}
export function codeBlock(editor: ComposerEditor): void {
  editor.format('code_block');
}
export function quote(editor: ComposerEditor): void {
  editor.format('blockquote');
}

export function replaceText(editor: ComposerEditor, text: string): void {
  const editorView = view(editor);
  for (const char of text) {
    const { from, to } = editorView.state.selection;
    const handled = editorView.someProp('handleTextInput', (handler) =>
      handler(editorView, from, to, char, () => editorView.state.tr)
    );
    if (!handled) editorView.dispatch(editorView.state.tr.insertText(char, from, to));
  }
}
