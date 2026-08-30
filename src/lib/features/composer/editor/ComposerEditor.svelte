<script lang="ts">
  import type { ComposerEditor } from './composer-editor';

  interface Props {
    editor: ComposerEditor;
    placeholder: string;
    empty: boolean;
  }

  let { editor, placeholder, empty }: Props = $props();

  function mount(node: HTMLElement): () => void {
    const detach = editor.mount(node);
    $effect(() => {
      editor.syncEditable();
    });
    $effect(() => {
      editor.syncLabel();
    });
    $effect(() => {
      editor.syncKeyHint();
    });
    return detach;
  }
</script>

<div class="editor" class:empty data-placeholder={placeholder} {@attach mount}></div>

<style>
  .editor {
    flex: 1;
    max-height: 10rem;
    min-height: var(--target);
    min-width: 0;
    overflow-y: auto;
    padding: var(--space-200);
    position: relative;
  }

  /* `white-space` comes from prosemirror.css, imported by `composer-editor.ts`. */
  .editor :global([contenteditable='true']) {
    font-size: max(var(--font-size-body), var(--font-size-input-min));
    outline: 0;
    overflow-wrap: anywhere;
  }

  .editor :global([contenteditable='true'] p) {
    margin: 0;
  }

  .editor :global(h1),
  .editor :global(h2),
  .editor :global(h3) {
    font-weight: var(--font-weight-bold);
    line-height: inherit;
    margin: 0;
  }

  .editor :global(h1) {
    font-size: var(--font-size-heading);
  }

  .editor :global(h2) {
    font-size: var(--font-size-heading);
  }

  .editor :global(h3) {
    font-size: inherit;
  }

  .editor :global(blockquote) {
    border-inline-start: calc(var(--border-width) * 3) solid var(--sable-primary-main);
    margin: 0;
    padding-inline-start: var(--space-300);
  }

  .editor :global(ul),
  .editor :global(ol) {
    margin: 0;
    padding-inline-start: var(--space-400);
  }

  .editor :global(code) {
    background: var(--sable-surface-var-container);
    border-radius: calc(var(--radius) - 0.25rem);
    padding: 0 var(--space-050);
  }

  .editor :global(pre) {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    margin: 0;
    overflow-x: auto;
    padding: var(--space-200);
  }

  .editor :global(a) {
    color: var(--sable-primary-main);
    text-decoration: underline;
  }

  .editor.empty::before {
    color: var(--sable-surface-var-on-container);
    content: attr(data-placeholder);
    left: var(--space-200);
    pointer-events: none;
    position: absolute;
    top: var(--space-200);
  }

  .editor :global(.composer-mention) {
    background: var(--sable-primary-container);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-container);
    padding: 0 var(--space-150);
  }

  /* ProseMirror's own class; the themed `.selected` below paints instead. */
  /* stylelint-disable-next-line selector-class-pattern */
  .editor :global(.ProseMirror-selectednode) {
    outline: 0;
  }

  .editor :global(.composer-mention.selected) {
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
  }

  .editor :global(.composer-emoticon img) {
    height: 1.5em;
    vertical-align: middle;
    width: auto;
  }

  .editor :global(.composer-emoticon.selected) {
    background: var(--sable-surface-container-active);
    border-radius: var(--radius);
  }
</style>
