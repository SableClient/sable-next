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
    return detach;
  }
</script>

<div class="editor" class:empty data-placeholder={placeholder} {@attach mount}></div>

<style>
  .editor {
    flex: 1;
    max-height: 10rem;
    min-height: 2.625rem;
    min-width: 0;
    overflow-y: auto;
    padding: 0.5rem 3rem 0.5rem 0.75rem;
    position: relative;
  }

  .editor :global([contenteditable='true']) {
    outline: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
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
    font-size: var(--font-size-large);
  }

  .editor :global(h2) {
    font-size: var(--font-size-medium);
  }

  .editor :global(h3) {
    font-size: inherit;
  }

  .editor :global(blockquote) {
    border-inline-start: 3px solid var(--sable-primary-main);
    margin: 0;
    padding-inline-start: var(--space-2);
  }

  .editor :global(ul),
  .editor :global(ol) {
    margin: 0;
    padding-inline-start: var(--space-3);
  }

  .editor :global(code) {
    background: var(--sable-surface-var-container);
    border-radius: calc(var(--radius) - 0.25rem);
    padding: 0 0.1875rem;
  }

  .editor :global(pre) {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    margin: 0;
    overflow-x: auto;
    padding: var(--space-1);
  }

  .editor :global(a) {
    color: var(--sable-primary-main);
    text-decoration: underline;
  }

  .editor.empty::before {
    color: var(--sable-surface-var-on-container);
    content: attr(data-placeholder);
    left: 0.75rem;
    pointer-events: none;
    position: absolute;
    top: 0.5rem;
  }

  .editor :global(.composer-mention) {
    background: var(--sable-primary-container);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-container);
    padding: 0 0.375rem;
  }

  .editor :global(.composer-mention.selected) {
    box-shadow: 0 0 0 2px var(--sable-focus-ring);
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
