import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  exitCode,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
  splitBlockKeepMarks,
} from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Slice, type Node as ProseMirrorNode, type ResolvedPos } from 'prosemirror-model';
import {
  Plugin,
  EditorState,
  Selection,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { untrack } from 'svelte';

/* ProseMirror's own stylesheet is load-bearing, not cosmetic: it hides the
   native caret and selection while a node selection is up, and disables the
   ligatures that would otherwise misplace the caret in Nunito. */
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';

import type { PackImageView } from '#src/generated/protocol';

import { preferences } from '#lib/settings/preferences.svelte.js';
import type { AutocompleteQuery } from '../autocomplete';
import { filesFrom } from '../composer-files';
import { compositionInputRules } from './composition-rules';
import {
  activeMarks,
  formatCommands,
  formattingInputRules,
  formattingKeymap,
  insideListItem,
  joinListItemBackward,
  sinkListEntry,
  splitListEntry,
  type FormatAction,
} from './formatting';
import { markdownFormatCommands, markdownLink } from './markdown-format';
import type { EmoteMedia } from './node-views';
import { composerNodeViews } from './node-views';
import { hasAndroidCompositionQuirk } from '#lib/platform/input.js';

import { filesFromSources, pastedImageSources } from './pasted-images';
import { mfmTimeInputRule } from './mfm';
import { queryKey, queryPlugin } from './query-plugin';
import { composerSchema, parseMatrixHtml } from './schema';
import {
  composerMarkdown,
  markdownFromSlice,
  markdownSlice,
  plainTextOf,
  richFromPlain,
  textDoc,
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
  const block = $from.parent;
  if (!state.selection.empty || block.type !== composerSchema.nodes.code_block) return false;
  if ($from.parentOffset !== block.content.size || !block.textContent.endsWith('\n')) return false;

  const paragraph = composerSchema.nodes.paragraph.createAndFill();
  if (!paragraph) return false;

  if (dispatch) {
    if (block.content.size === 1) {
      const tr = state.tr.replaceWith($from.before(), $from.after(), paragraph);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1)).scrollIntoView());
      return true;
    }
    const position = $from.after() - 1;
    const tr = state.tr.delete($from.pos - 1, $from.pos);
    const next = tr.doc.resolve(position).nodeAfter;
    if (next?.type !== composerSchema.nodes.paragraph || next.content.size > 0) {
      tr.insert(position, paragraph);
    }
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(position), 1)).scrollIntoView());
  }
  return true;
};

const deleteInlineAtomBackward: Command = (state, dispatch) => {
  const cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
  const before = cursor?.nodeBefore;
  if (!cursor || !before?.isInline || before.type.spec.atom !== true) return false;
  dispatch?.(state.tr.delete(cursor.pos - before.nodeSize, cursor.pos).scrollIntoView());
  return true;
};

const ANDROID_DELETE_WINDOW_MS = 200;

function selectsAtomBeforeCursor(state: EditorState, tr: Transaction): boolean {
  if (tr.docChanged || tr.getMeta('pointer') === true) return false;
  const cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
  const { from, to } = tr.selection;
  const atom = tr.doc.nodeAt(from);
  return (
    cursor?.pos === to &&
    atom !== null &&
    atom.isInline &&
    atom.type.spec.atom === true &&
    from + atom.nodeSize === to
  );
}

function isHeadingLike(node: ProseMirrorNode): boolean {
  return node.type === composerSchema.nodes.heading || node.type === composerSchema.nodes.subtext;
}

const headingToParagraphBackward: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !isHeadingLike($from.parent) || $from.parentOffset !== 0) {
    return false;
  }
  dispatch?.(state.tr.setBlockType($from.before(), $from.after(), composerSchema.nodes.paragraph));
  return true;
};

const deleteEmptyCodeBlock: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const block = $from.parent;
  if (!state.selection.empty || block.type !== composerSchema.nodes.code_block) return false;
  if ($from.parentOffset !== 0 || block.content.size !== 0) return false;

  const from = $from.before();
  const to = $from.after();
  const container = $from.node(-1);
  const canDelete = container.canReplace($from.index(-1), $from.indexAfter(-1));

  if (dispatch) {
    const tr = canDelete
      ? state.tr.delete(from, to)
      : state.tr.setBlockType(from, to, composerSchema.nodes.paragraph);
    const position = Math.min(from, tr.doc.content.size);
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(position), -1)).scrollIntoView());
  }
  return true;
};

const FENCE = /^```([^`\s]*)[ \t]*$/;

function softLineStart($from: ResolvedPos): number {
  const { parent } = $from;
  let start = $from.start();
  parent.forEach((child, offset) => {
    if (child.type === composerSchema.nodes.hard_break && offset < $from.parentOffset) {
      start = $from.start() + offset + 1;
    }
  });
  return start;
}

const openFence: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const block = $from.parent;
  if (!state.selection.empty || block.type !== composerSchema.nodes.paragraph) return false;
  if ($from.parentOffset !== block.content.size) return false;

  const lineStart = softLineStart($from);
  const match = FENCE.exec(state.doc.textBetween(lineStart, $from.pos));
  if (!match) return false;

  const $start = state.doc.resolve($from.start());
  const codeBlock = composerSchema.nodes.code_block;
  if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), codeBlock)) {
    return false;
  }

  if (dispatch) {
    const tr = state.tr.delete(lineStart, $from.pos);
    let position = lineStart;
    if (lineStart > $from.start()) {
      tr.delete(lineStart - 1, lineStart).split(lineStart - 1);
      position = lineStart + 1;
    }
    dispatch(
      tr.setBlockType(position, position, codeBlock, { language: match[1] }).scrollIntoView()
    );
  }
  return true;
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

const exitHeadingOnSoftBreak: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !isHeadingLike($from.parent)) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  return splitBlock(state, dispatch);
};

const exitQuoteOnSoftBreak: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const { paragraph, hard_break: hardBreak, blockquote } = composerSchema.nodes;
  if (!empty || $from.parent.type !== paragraph || $from.depth < 2) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  if ($from.nodeBefore?.type !== hardBreak || $from.node(-1).type !== blockquote) return false;
  if ($from.index(-1) !== $from.node(-1).childCount - 1) return false;

  if (dispatch) {
    const after = $from.after(-1) - 1;
    const tr = state.tr.delete($from.pos - 1, $from.pos).insert(after, paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
  }
  return true;
};

/** Shift+Enter: stay in the paragraph so the marks survive serialization. */
const softBreak: Command = chainCommands(
  newlineInCode,
  exitHeadingOnSoftBreak,
  exitQuoteOnSoftBreak,
  insertHardBreak
);

/** `baseKeymap`'s Enter, re-chained because ours shadows it. */
const splitEntry: Command = chainCommands(
  newlineInCode,
  splitListEntry,
  createParagraphNear,
  liftEmptyBlock,
  splitBlockKeepMarks
);

function codeLanguageLabels(): Plugin {
  return new Plugin({
    props: {
      decorations: (state) => {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, position) => {
          if (node.type !== composerSchema.nodes.code_block) return true;
          const language = node.attrs.language as string;
          if (language !== '') {
            decorations.push(
              Decoration.node(position, position + node.nodeSize, { 'data-language': language })
            );
          }
          return false;
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

function isTrailingParagraph(doc: ProseMirrorNode): boolean {
  const last = doc.lastChild;
  if (!last || doc.childCount < 2) return false;
  if (last.type !== composerSchema.nodes.paragraph || last.content.size > 0) return false;
  return doc.child(doc.childCount - 2).type !== composerSchema.nodes.paragraph;
}

const undoBlockRule: Command = (state, dispatch, view) =>
  undoInputRule(
    state,
    dispatch &&
      ((tr) => {
        const last = tr.doc.lastChild;
        if (isTrailingParagraph(state.doc) && last && !isTrailingParagraph(tr.doc)) {
          if (last.type === composerSchema.nodes.paragraph && last.content.size === 0) {
            tr.delete(tr.doc.content.size - last.nodeSize, tr.doc.content.size);
          }
        }
        dispatch(tr);
      }),
    view
  );

function trailingParagraph(): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _old, state) => {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const last = state.doc.lastChild;
      if (!last || last.type === composerSchema.nodes.paragraph) return null;
      if (last.type === composerSchema.nodes.code_block) return null;
      const tr = state.tr.insert(state.doc.content.size, composerSchema.nodes.paragraph.create());
      for (const plugin of state.plugins) {
        if ((plugin.spec as { isInputRules?: boolean }).isInputRules) {
          tr.setMeta(plugin, plugin.getState(state) as unknown);
        }
      }
      return tr;
    },
  });
}

const URL_ONLY = /^(?:https?:\/\/|mailto:)\S+$/;

const PILL_SPACE = 'pillSpace';

function documentEdgeGuard(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        keydown: (view, event) => {
          const left = event.key === 'ArrowLeft';
          if (!left && event.key !== 'ArrowRight') return false;
          const { selection, doc } = view.state;
          const edge = left ? Selection.atStart(doc) : Selection.atEnd(doc);
          const edgePos = left ? edge.from : edge.to;
          if ((left ? selection.from : selection.to) !== edgePos) return false;
          if (event.shiftKey && selection.head !== edgePos) return false;
          event.preventDefault();
          if (!event.shiftKey && !selection.eq(edge)) {
            view.dispatch(view.state.tr.setSelection(edge));
          }
          return true;
        },
      },
    },
  });
}

const INDENT = '    ';

function insideFence(state: EditorState): boolean {
  const { $from } = state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', (node) =>
    node.type === composerSchema.nodes.hard_break ? '\n' : ''
  );
  const fences = before.split('\n').filter((line) => line.trimStart().startsWith('```'));
  return fences.length % 2 === 1;
}

function indentCode(markdown: boolean): Command {
  return (state, dispatch) => {
    const inCode = state.selection.$from.parent.type.spec.code === true;
    if (!inCode && !(markdown && insideFence(state))) return false;
    dispatch?.(state.tr.insertText(INDENT));
    return true;
  };
}

function atDocumentEdge(direction: 'up' | 'down'): Command {
  return (state, _dispatch, view) => {
    if (!state.selection.empty || !view) return false;
    const { $from } = state.selection;
    const edgeBlock =
      direction === 'up' ? $from.index(0) === 0 : $from.index(0) === state.doc.childCount - 1;
    return edgeBlock && view.endOfTextblock(direction);
  };
}

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

function isDocEmpty(doc: ProseMirrorNode): boolean {
  if (doc.textContent.trim() !== '') return false;

  let atom = false;
  doc.descendants((node) => {
    if (node.isAtom && !node.isText && node.type !== composerSchema.nodes.hard_break) atom = true;
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
  private detachedDoc: ProseMirrorNode | undefined;
  private source = false;
  private pillSpace: number | null = null;
  private androidDelete: { pos: number; at: number } | null = null;

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
    const rich = preferences.richTextComposer && !this.source;
    if (rich && openFence(state, dispatch, view)) return true;
    if (exitEmptyCodeLine(state, dispatch, view)) return true;
    if (newlineInCode(state, dispatch, view)) return true;
    if (splitListEntry(state, dispatch, view)) return true;
    if (insideListItem(state) && liftEmptyBlock(state, dispatch, view)) return true;
    if (!preferences.enterForNewline) return this.submit();
    return rich ? splitEntry(state, dispatch, view) : insertHardBreak(state, dispatch, view);
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

  private plugins(): Plugin[] {
    /* Read once, here, rather than inside the view: an option the constructor
       calls becomes a dependency of the attachment that mounts it. */
    const rich = untrack(() => preferences.richTextComposer) && !this.source;

    return [
      history(),
      documentEdgeGuard(),
      queryPlugin(),
      inputRules({
        rules: [
          shortcodeInputRule(this.options.emotes),
          ...(rich
            ? [mfmTimeInputRule(composerSchema.nodes.mfm_time), ...formattingInputRules]
            : []),
        ],
      }),
      compositionInputRules(),
      ...(rich
        ? [
            keymap(formattingKeymap),
            keymap({
              'Mod-Shift-k': () => {
                this.options.onLinkRequest();
                return true;
              },
            }),
          ]
        : []),
      gapCursor(),
      dropCursor(),
      trailingParagraph(),
      codeLanguageLabels(),
      keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Shift-Mod-z': redo,
        Backspace: chainCommands(
          deleteEmptyCodeBlock,
          undoBlockRule,
          deleteInlineAtomBackward,
          joinListItemBackward,
          headingToParagraphBackward
        ),
        ArrowUp: (state, dispatch, view) =>
          this.options.onNavigate('ArrowUp') || atDocumentEdge('up')(state, dispatch, view),
        ArrowDown: (state, dispatch, view) =>
          this.options.onNavigate('ArrowDown') || atDocumentEdge('down')(state, dispatch, view),
        'Shift-ArrowUp': chainCommands(escapeCodeBlock(-1), enterCodeBlock(-1)),
        'Shift-ArrowDown': chainCommands(escapeCodeBlock(1), enterCodeBlock(1)),
        Tab: (state, dispatch, view) =>
          this.options.onNavigate('Tab') ||
          indentCode(this.markdownMode())(state, dispatch, view) ||
          sinkListEntry(state, dispatch, view),
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
    ];
  }

  private createState(doc?: ProseMirrorNode, selection?: Selection): EditorState {
    return EditorState.create({
      ...(doc ? { doc } : {}),
      ...(selection ? { selection } : {}),
      schema: composerSchema,
      plugins: this.plugins(),
    });
  }

  private reconfigurePlugins(): void {
    const view = this.view;
    if (!view) return;
    view.updateState(view.state.reconfigure({ plugins: this.plugins() }));
    this.report(view.state, false);
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
            this.handlePastedImages(slice) ||
            this.linkSelection(pasteView, slice) ||
            this.pasteAsText(pasteView, event),
          clipboardTextParser: (text, _context, plain) =>
            plain || this.source || !preferences.richTextComposer
              ? textSlice(text)
              : markdownSlice(text),
          handleTextInput: (_inputView, from, to, text) => {
            if (text !== ' ' || from !== to || from !== this.pillSpace) return false;
            this.pillSpace = null;
            return true;
          },
          clipboardTextSerializer: (slice) => markdownFromSlice(slice),
          handleDrop: (_view, event) => this.handleFiles(filesFrom(event.dataTransfer)),
          handleDOMEvents: {
            beforeinput: (view, event) => {
              if (event.inputType === 'deleteContentBackward') {
                if (hasAndroidCompositionQuirk()) {
                  this.androidDelete = { pos: view.state.selection.head, at: Date.now() };
                }
                if (
                  event.cancelable &&
                  chainCommands(deleteEmptyCodeBlock, deleteInlineAtomBackward)(
                    view.state,
                    (tr) => {
                      view.dispatch(tr);
                    },
                    view
                  )
                ) {
                  event.preventDefault();
                  return true;
                }
                if (!hasAndroidCompositionQuirk()) return false;
                handleAndroidDeleteBackward(view);
                return true;
              }
              if (!hasAndroidCompositionQuirk()) return false;
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
            if (this.keepCaretOffPill(view, tr)) return;
            this.pillSpace = (tr.getMeta(PILL_SPACE) as number | undefined) ?? null;
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
      if (this.view === view) {
        this.detachedDoc = view.state.doc;
        this.view = undefined;
      }
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
    const doc = this.doc();
    return doc ? isDocEmpty(doc) : true;
  }

  doc(): ProseMirrorNode | undefined {
    return this.view ? this.view.state.doc : this.detachedDoc;
  }

  text(): string {
    const doc = this.view?.state.doc;
    return doc ? plainTextOf(doc) : '';
  }

  editable(): HTMLElement | undefined {
    return this.view?.dom;
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
      this.reconfigurePlugins();
      this.setDoc(richFromPlain(doc));
    } else {
      this.source = true;
      this.reconfigurePlugins();
      this.setSource(composerMarkdown(doc));
    }
    return this.source;
  }

  leaveSource(): boolean {
    if (this.source) {
      this.source = false;
      this.reconfigurePlugins();
    }
    return false;
  }

  private keepCaretOffPill(view: EditorView, tr: Transaction): boolean {
    const last = this.androidDelete;
    if (!last || Date.now() - last.at > ANDROID_DELETE_WINDOW_MS) return false;
    if (!selectsAtomBeforeCursor(view.state, tr)) return false;
    this.androidDelete = null;
    const { from, to } = tr.selection;
    if (to === last.pos) view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
    view.focus();
    return true;
  }

  private handlePastedImages(slice: Slice): boolean {
    const sources = pastedImageSources(slice);
    if (sources.length === 0) return false;
    void filesFromSources(sources).then((files) => this.handleFiles(files));
    return true;
  }

  private pasteAsText(view: EditorView, event: ClipboardEvent): boolean {
    if (!this.markdownMode()) return false;
    const text = event.clipboardData?.getData('text/plain');
    if (!text || event.clipboardData?.getData('text/html').includes('data-pm-slice')) return false;
    view.dispatch(view.state.tr.replaceSelection(textSlice(text)).scrollIntoView());
    return true;
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
    this.setDoc(textDoc(text));
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
    const after = from + node.nodeSize + 1;
    const tr = view.state.tr.replaceWith(from, to, [node, composerSchema.text(' ')]);
    tr.setSelection(TextSelection.create(tr.doc, after)).setMeta(PILL_SPACE, after);
    view.dispatch(tr);
    view.focus();
  }

  private handleFiles(files: File[]): boolean {
    if (files.length === 0) return false;
    this.options.onFiles(files);
    return true;
  }

  private markdownMode(): boolean {
    return this.source || !preferences.richTextComposer;
  }

  format(action: FormatAction): void {
    const view = this.view;
    if (!view) return;
    if (action === 'link') {
      this.options.onLinkRequest();
      return;
    }
    if (this.markdownMode()) {
      markdownFormatCommands[action]?.(view.state, view.dispatch, view);
      view.focus();
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
    if (this.markdownMode()) {
      view.dispatch(view.state.tr.replaceSelectionWith(markdownLink(view.state, href), false));
      view.focus();
      return;
    }
    const { from, to, empty } = view.state.selection;
    const mark = composerSchema.marks.link.create({ href });
    const tr = empty
      ? view.state.tr.insertText(href, from).addMark(from, from + href.length, mark)
      : view.state.tr.addMark(from, to, mark);
    view.dispatch(tr);
    view.focus();
  }
}
