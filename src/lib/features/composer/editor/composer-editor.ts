import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  exitCode,
  liftEmptyBlock,
  newlineInCode,
  splitBlockKeepMarks,
} from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Slice, type Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, EditorState, Selection, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { untrack } from 'svelte';

/* ProseMirror's own stylesheet is load-bearing, not cosmetic: it hides the
   native caret and selection while a node selection is up, and disables the
   ligatures that would otherwise misplace the caret in Nunito. */
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';

import type { PackImageView } from '#src/generated/PackImageView';

import { preferences } from '#lib/settings/preferences.svelte.js';
import type { AutocompleteQuery } from '../autocomplete';
import {
  activeMarks,
  formatCommands,
  formattingInputRules,
  formattingKeymap,
  sinkListEntry,
  splitListEntry,
  type FormatAction,
} from './formatting';
import type { EmoteMedia } from './node-views';
import { composerNodeViews } from './node-views';
import { hasAndroidCompositionQuirk } from '#lib/platform/input.js';

import { queryKey, queryPlugin } from './query-plugin';
import { composerSchema, parseMatrixHtml } from './schema';
import {
  markdownFromSlice,
  markdownSlice,
  richFromPlain,
  serializeComposer,
  textSlice,
} from './serialize';
import { shortcodeInputRule } from './shortcodes';

const androidBackspaceKeyEvent = (): KeyboardEvent =>
  new KeyboardEvent('keydown', {
    key: 'Backspace',
    code: 'Backspace',
    bubbles: true,
    cancelable: true,
  });

function handleAndroidDeleteBackward(view: EditorView): void {
  const cursor =
    view.state.selection instanceof TextSelection ? view.state.selection.$cursor : null;
  if (!cursor || cursor.pos <= 0) return;

  const position = cursor.pos;
  const contentSize = view.state.doc.content.size;
  window.setTimeout(() => {
    // The IME already changed the DOM, so let ProseMirror's observer handle it.
    const cursorAfter =
      view.state.selection instanceof TextSelection ? view.state.selection.$cursor : null;
    if (!cursorAfter || cursorAfter.pos !== position) return;
    if (view.state.doc.content.size !== contentSize) return;
    if (view.someProp('handleKeyDown', (handler) => handler(view, androidBackspaceKeyEvent())))
      return;
    view.dispatch(view.state.tr.delete(position - 1, position));
  }, 50);
}

const insertHardBreak: Command = (state, dispatch) => {
  dispatch?.(
    state.tr.replaceSelectionWith(composerSchema.nodes.hard_break.create()).scrollIntoView()
  );
  return true;
};

const exitEmptyCodeLine: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (!state.selection.empty || $from.parent.type !== composerSchema.nodes.code_block) {
    return false;
  }

  const text = $from.parent.textContent;
  const lineStart = text.lastIndexOf('\n', $from.parentOffset - 1) + 1;
  if (text.slice(lineStart, $from.parentOffset) !== '') return false;
  return exitCode(state, dispatch);
};

function escapeCodeBlock(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (!state.selection.empty || $from.parent.type !== composerSchema.nodes.code_block) {
      return false;
    }

    const text = $from.parent.textContent;
    const onBoundaryLine =
      direction < 0
        ? text.lastIndexOf('\n', $from.parentOffset - 1) < 0
        : text.indexOf('\n', $from.parentOffset) < 0;
    if (!onBoundaryLine) return false;

    const parent = $from.node(-1);
    const index = $from.index(-1);
    const adjacent = direction < 0 ? index - 1 : index + 1;
    const position = direction < 0 ? $from.before() : $from.after();
    if (adjacent >= 0 && adjacent < parent.childCount) {
      if (dispatch) {
        dispatch(
          state.tr
            .setSelection(Selection.near(state.doc.resolve(position), direction))
            .scrollIntoView()
        );
      }
      return true;
    }

    if (direction > 0) return exitCode(state, dispatch);
    if (dispatch) {
      const tr = state.tr.insert(position, composerSchema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, position + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

function enterCodeBlock(direction: -1 | 1): Command {
  return (state, dispatch, view) => {
    const { $from, empty } = state.selection;
    const codeBlock = composerSchema.nodes.code_block;
    if (!empty || !$from.parent.isTextblock || $from.parent.type === codeBlock) return false;

    const atEdge = view
      ? view.endOfTextblock(direction < 0 ? 'up' : 'down')
      : $from.parentOffset === (direction < 0 ? 0 : $from.parent.content.size);
    if (!atEdge) return false;

    const parent = $from.node(-1);
    const adjacent = $from.index(-1) + direction;
    if (adjacent < 0 || adjacent >= parent.childCount) return false;
    if (parent.child(adjacent).type !== codeBlock) return false;

    if (dispatch) {
      const position = direction < 0 ? $from.before() - 1 : $from.after() + 1;
      dispatch(
        state.tr
          .setSelection(TextSelection.near(state.doc.resolve(position), direction))
          .scrollIntoView()
      );
    }
    return true;
  };
}

/** Shift+Enter: stay in the paragraph so the marks survive serialization. */
const softBreak: Command = chainCommands(newlineInCode, insertHardBreak);

/** `baseKeymap`'s Enter, re-chained because ours shadows it. */
const splitEntry: Command = chainCommands(
  newlineInCode,
  splitListEntry,
  createParagraphNear,
  liftEmptyBlock,
  splitBlockKeepMarks
);

function trailingParagraph(): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _old, state) => {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const last = state.doc.lastChild;
      if (!last || last.type === composerSchema.nodes.paragraph) return null;
      return state.tr.insert(state.doc.content.size, composerSchema.nodes.paragraph.create());
    },
  });
}

const URL_ONLY = /^(?:https?:\/\/|mailto:)\S+$/;

export type NavigationKey = 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape';

export interface ComposerChange {
  empty: boolean;
  placeholder: boolean;
  active: FormatAction[];
  docChanged: boolean;
}

export interface ComposerEditorOptions {
  media: EmoteMedia;
  emotes: () => readonly PackImageView[];
  label: () => string;
  describedBy?: string;
  listboxId: string;
  activeOptionId: () => string | null;
  editable: () => boolean;
  onSubmit: () => void;
  onChange: (change: ComposerChange) => void;
  onQuery: (query: AutocompleteQuery | null) => void;
  onNavigate: (key: NavigationKey) => boolean;
  onFiles: (files: File[]) => void;
  onLinkRequest: () => void;
  onSpoilerRequest: () => void;
  onSourceToggle: (source: boolean) => void;
}

function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return Array.from(transfer.files).filter((file): file is File => file instanceof File);
}

function isDocEmpty(doc: ProseMirrorNode): boolean {
  if (doc.textContent.trim() !== '') return false;

  let atom = false;
  doc.descendants((node) => {
    if (node.isAtom && !node.isText) atom = true;
    return !atom;
  });
  return !atom;
}

function isPlaceholderDoc(doc: ProseMirrorNode): boolean {
  const first = doc.firstChild;
  return (
    doc.childCount === 1 &&
    first !== null &&
    first.type === composerSchema.nodes.paragraph &&
    first.content.size === 0
  );
}

export class ComposerEditor {
  private view: EditorView | undefined;
  private source = false;

  constructor(private options: ComposerEditorOptions) {}

  private report(state: EditorState, docChanged: boolean): void {
    this.options.onChange({
      empty: isDocEmpty(state.doc),
      placeholder: isPlaceholderDoc(state.doc),
      active: activeMarks(state),
      docChanged,
    });
  }

  private submit(): boolean {
    this.options.onSubmit();
    return true;
  }

  private enter: Command = (state, dispatch, view) => {
    if (this.options.onNavigate('Enter')) return true;
    if (exitEmptyCodeLine(state, dispatch, view)) return true;
    if (newlineInCode(state, dispatch, view)) return true;
    return preferences.enterForNewline ? splitEntry(state, dispatch, view) : this.submit();
  };

  private domAttributes(): Record<string, string> {
    const activeOption = this.options.activeOptionId();

    return {
      'aria-label': this.options.label(),
      role: 'combobox',
      'aria-controls': this.options.listboxId,
      'aria-expanded': activeOption === null ? 'false' : 'true',
      ...(activeOption === null ? {} : { 'aria-activedescendant': activeOption }),
      /* No `aria-multiline`: it is a textbox property, invalid on a combobox. */
      spellcheck: 'true',
      autocapitalize: 'sentences',
      enterkeyhint: preferences.enterForNewline ? 'enter' : 'send',
      ...(this.options.describedBy ? { 'aria-describedby': this.options.describedBy } : {}),
    };
  }

  private createState(doc?: ProseMirrorNode, selection?: Selection): EditorState {
    /* Read once, here, rather than inside the view: an option the constructor
       calls becomes a dependency of the attachment that mounts it. */
    const rich = untrack(() => preferences.richTextComposer);

    return EditorState.create({
      ...(doc ? { doc } : {}),
      ...(selection ? { selection } : {}),
      schema: composerSchema,
      plugins: [
        history(),
        queryPlugin(),
        inputRules({
          rules: [shortcodeInputRule(this.options.emotes), ...(rich ? formattingInputRules : [])],
        }),
        ...(rich
          ? [
              keymap(formattingKeymap),
              keymap({
                'Mod-k': () => {
                  this.options.onLinkRequest();
                  return true;
                },
              }),
            ]
          : []),
        gapCursor(),
        dropCursor(),
        trailingParagraph(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Shift-Mod-z': redo,
          Backspace: undoInputRule,
          ArrowUp: () => this.options.onNavigate('ArrowUp'),
          ArrowDown: () => this.options.onNavigate('ArrowDown'),
          'Shift-ArrowUp': chainCommands(escapeCodeBlock(-1), enterCodeBlock(-1)),
          'Shift-ArrowDown': chainCommands(escapeCodeBlock(1), enterCodeBlock(1)),
          Tab: (state, dispatch, view) =>
            this.options.onNavigate('Tab') || sinkListEntry(state, dispatch, view),
          Escape: () => this.options.onNavigate('Escape'),
          Enter: this.enter,
          'Shift-Enter': (state, dispatch, view) =>
            preferences.enterForNewline ? this.submit() : softBreak(state, dispatch, view),
          'Mod-Enter': () => this.submit(),
          'Mod-Shift-m': () => {
            this.options.onSourceToggle(this.toggleSource());
            return true;
          },
        }),
        keymap(baseKeymap),
      ],
    });
  }

  private rebuild(): void {
    const view = this.view;
    if (!view) return;
    view.updateState(this.createState(view.state.doc, view.state.selection));
    this.report(view.state, false);
    this.options.onQuery(queryKey.getState(view.state) ?? null);
  }

  reconfigure(): void {
    this.rebuild();
  }

  mount(node: HTMLElement): () => void {
    const state = this.createState();

    /* The constructor calls editable() and reads the attributes, so an unguarded
       build makes every option a dependency of the attachment that mounts it. */
    const view: EditorView = untrack(
      () =>
        new EditorView(node, {
          state,
          editable: () => this.options.editable(),
          nodeViews: composerNodeViews(this.options.media),
          attributes: () => this.domAttributes(),
          handlePaste: (pasteView, event, slice) =>
            this.handleFiles(filesFrom(event.clipboardData)) ||
            this.linkSelection(pasteView, slice),
          clipboardTextParser: (text, _context, plain) =>
            plain || !preferences.richTextComposer ? textSlice(text) : markdownSlice(text),
          clipboardTextSerializer: (slice) => markdownFromSlice(slice),
          handleDrop: (_view, event) => this.handleFiles(filesFrom(event.dataTransfer)),
          handleDOMEvents: {
            beforeinput: (view, event) => {
              if (!hasAndroidCompositionQuirk()) return false;
              if (event.inputType === 'deleteContentBackward') {
                handleAndroidDeleteBackward(view);
                return true;
              }
              if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
                event.preventDefault();
                return this.enter(
                  view.state,
                  (tr) => {
                    view.dispatch(tr);
                  },
                  view
                );
              }
              return false;
            },
          },
          dispatchTransaction: (tr) => {
            const next = view.state.apply(tr);
            view.updateState(next);
            this.report(next, tr.docChanged);
            this.options.onQuery(queryKey.getState(next) ?? null);
          },
        })
    );

    this.view = view;

    return () => {
      view.destroy();
      if (this.view === view) this.view = undefined;
    };
  }

  /** Read here rather than relying on the re-read `setProps` triggers, so the
      caller's effect actually depends on it. */
  syncEditable(): void {
    void this.options.editable();
    this.view?.setProps({});
  }

  syncLabel(): void {
    void this.options.label();
    this.view?.setProps({});
  }

  syncKeyHint(): void {
    void preferences.enterForNewline;
    this.view?.setProps({});
  }

  syncActiveOption(): void {
    void this.options.activeOptionId();
    this.view?.setProps({});
  }

  isEmpty(): boolean {
    const doc = this.view?.state.doc;
    return doc ? isDocEmpty(doc) : true;
  }

  doc(): ProseMirrorNode | undefined {
    return this.view?.state.doc;
  }

  focus(): void {
    this.view?.focus();
  }

  blur(): void {
    this.view?.dom.blur();
  }

  clear(): void {
    const view = this.view;
    if (!view) return;
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
  }

  clearHistory(): void {
    this.rebuild();
  }

  setDoc(doc: ProseMirrorNode): void {
    const view = this.view;
    if (!view) return;
    const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    transaction.setSelection(Selection.atEnd(transaction.doc));
    view.dispatch(transaction);
  }

  setHtml(html: string): void {
    this.setDoc(parseMatrixHtml(html));
  }

  toggleSource(): boolean {
    const doc = this.doc();
    if (!doc) return false;

    if (this.source) {
      this.source = false;
      this.setDoc(richFromPlain(doc));
    } else {
      this.source = true;
      this.setSource(serializeComposer(doc).body);
    }
    return this.source;
  }

  leaveSource(): boolean {
    this.source = false;
    return false;
  }

  private linkSelection(view: EditorView, slice: Slice): boolean {
    const text = slice.content.textBetween(0, slice.content.size).trim();
    if (!URL_ONLY.test(text) || view.state.selection.empty) return false;

    const { from, to } = view.state.selection;
    view.dispatch(
      view.state.tr.addMark(from, to, composerSchema.marks.link.create({ href: text }))
    );
    return true;
  }

  private setSource(text: string): void {
    const { paragraph, hard_break: hardBreak } = composerSchema.nodes;
    const content: ProseMirrorNode[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (index > 0) content.push(hardBreak.create());
      if (line !== '') content.push(composerSchema.text(line));
    }
    this.setDoc(composerSchema.node('doc', null, paragraph.create(null, content)));
  }

  setText(text: string): void {
    const paragraphs = text
      .split('\n')
      .map((line) =>
        composerSchema.nodes.paragraph.create(null, line ? composerSchema.text(line) : null)
      );
    this.setDoc(composerSchema.node('doc', null, paragraphs));
  }

  insert(node: ProseMirrorNode): void {
    const view = this.view;
    if (!view) return;
    const { from, to } = view.state.selection;
    this.replaceRange(from, to, node);
  }

  replaceQuery(query: AutocompleteQuery, node: ProseMirrorNode): void {
    this.replaceRange(query.start, query.end, node);
  }

  /** The servers arrive after the mention is inserted, so they are patched in
      rather than replacing what has been typed since. */
  attachVia(userId: string, via: readonly string[]): void {
    const view = this.view;
    if (!view || via.length === 0) return;

    const tr = view.state.tr;
    view.state.doc.descendants((node, pos) => {
      if (node.type !== composerSchema.nodes.mention) return true;
      if (node.attrs.userId !== userId || (node.attrs.via as string[]).length > 0) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, via: [...via] });
      return false;
    });

    if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false));
  }

  private replaceRange(from: number, to: number, node: ProseMirrorNode): void {
    const view = this.view;
    if (!view) return;
    const tr = view.state.tr.replaceWith(from, to, [node, composerSchema.text(' ')]);
    tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize + 1));
    view.dispatch(tr);
    view.focus();
  }

  private handleFiles(files: File[]): boolean {
    if (files.length === 0) return false;
    this.options.onFiles(files);
    return true;
  }

  format(action: FormatAction): void {
    const view = this.view;
    if (!view) return;
    if (action === 'link') {
      this.options.onLinkRequest();
      return;
    }
    if (action === 'spoiler' && !activeMarks(view.state).includes('spoiler')) {
      this.options.onSpoilerRequest();
      return;
    }
    formatCommands[action](view.state, view.dispatch, view);
    view.focus();
  }

  applySpoiler(reason: string): void {
    const view = this.view;
    if (!view) return;
    const { from, to, empty } = view.state.selection;
    const mark = composerSchema.marks.spoiler.create({ reason });
    if (empty) view.dispatch(view.state.tr.addStoredMark(mark));
    else view.dispatch(view.state.tr.addMark(from, to, mark));
    view.focus();
  }

  applyLink(href: string): void {
    const view = this.view;
    if (!view) return;
    const { from, to, empty } = view.state.selection;
    const mark = composerSchema.marks.link.create({ href });
    const tr = empty
      ? view.state.tr.insertText(href, from).addMark(from, from + href.length, mark)
      : view.state.tr.addMark(from, to, mark);
    view.dispatch(tr);
    view.focus();
  }
}
