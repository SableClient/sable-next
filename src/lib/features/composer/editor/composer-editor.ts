import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlockKeepMarks,
} from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { DOMParser, type Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, Selection, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { untrack } from 'svelte';

/* ProseMirror's own stylesheet is load-bearing, not cosmetic: it hides the
   native caret and selection while a node selection is up, and disables the
   ligatures that would otherwise misplace the caret in Nunito. */
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';

import { preferences } from '#lib/settings/preferences.svelte.js';
import type { AutocompleteQuery } from '../autocomplete';
import {
  activeMarks,
  formatCommands,
  formattingKeymap,
  formattingRules,
  sinkListEntry,
  splitListEntry,
  type FormatAction,
} from './formatting';
import type { EmoteMedia } from './node-views';
import { composerNodeViews } from './node-views';
import { queryKey, queryPlugin } from './query-plugin';
import { composerSchema } from './schema';

const isAndroid = (): boolean => /Android \d/.test(navigator.userAgent);

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

export type NavigationKey = 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape';

export interface ComposerEditorOptions {
  media: EmoteMedia;
  label: () => string;
  describedBy?: string;
  listboxId: string;
  activeOptionId: () => string | null;
  editable: () => boolean;
  onSubmit: () => void;
  onChange: (empty: boolean, active: FormatAction[], docChanged: boolean) => void;
  onQuery: (query: AutocompleteQuery | null) => void;
  onNavigate: (key: NavigationKey) => boolean;
  onFiles: (files: File[]) => void;
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

export class ComposerEditor {
  private view: EditorView | undefined;

  constructor(private options: ComposerEditorOptions) {}

  private submit(): boolean {
    this.options.onSubmit();
    return true;
  }

  private enter: Command = (state, dispatch, view) => {
    if (this.options.onNavigate('Enter')) return true;
    /* A code block owns Enter whichever way the preference is set, or a
       multi-line snippet sends itself one line at a time. */
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

  private createState(doc?: ProseMirrorNode): EditorState {
    /* Read once, here, rather than inside the view: an option the constructor
       calls becomes a dependency of the attachment that mounts it. */
    const rich = untrack(() => preferences.richTextComposer);

    return EditorState.create({
      ...(doc ? { doc } : {}),
      schema: composerSchema,
      plugins: [
        history(),
        queryPlugin(),
        ...(rich ? [formattingRules(), keymap(formattingKeymap)] : []),
        gapCursor(),
        dropCursor(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Shift-Mod-z': redo,
          Backspace: undoInputRule,
          ArrowUp: () => this.options.onNavigate('ArrowUp'),
          ArrowDown: () => this.options.onNavigate('ArrowDown'),
          Tab: (state, dispatch, view) =>
            this.options.onNavigate('Tab') || sinkListEntry(state, dispatch, view),
          Escape: () => this.options.onNavigate('Escape'),
          Enter: this.enter,
          'Shift-Enter': (state, dispatch, view) =>
            preferences.enterForNewline ? this.submit() : softBreak(state, dispatch, view),
          'Mod-Enter': () => this.submit(),
        }),
        keymap(baseKeymap),
      ],
    });
  }

  /** Swapping the input rules in or out means rebuilding the plugin stack. */
  reconfigure(): void {
    const view = this.view;
    if (!view) return;
    view.updateState(this.createState(view.state.doc));
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
          handlePaste: (_view, event) => this.handleFiles(filesFrom(event.clipboardData)),
          handleDrop: (_view, event) => this.handleFiles(filesFrom(event.dataTransfer)),
          handleDOMEvents: {
            beforeinput: (view, event) => {
              if (!isAndroid()) return false;
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
            this.options.onChange(isDocEmpty(next.doc), activeMarks(next), tr.docChanged);
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
    const view = this.view;
    if (!view) return;
    view.updateState(this.createState(view.state.doc));
  }

  setDoc(doc: ProseMirrorNode): void {
    const view = this.view;
    if (!view) return;
    const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    transaction.setSelection(Selection.atEnd(transaction.doc));
    view.dispatch(transaction);
  }

  setHtml(html: string): void {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    this.setDoc(DOMParser.fromSchema(composerSchema).parse(holder));
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
    formatCommands[action](view.state, view.dispatch, view);
    view.focus();
  }
}
