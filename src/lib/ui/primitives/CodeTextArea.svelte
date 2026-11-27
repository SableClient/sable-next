<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import './form-control.css';

  type Props = Omit<HTMLTextareaAttributes, 'class' | 'value'> & {
    value?: string;
    language: string;
    error?: boolean;
    rows?: number;
  };

  let { value = $bindable(''), language, error = false, rows = 16, ...rest }: Props = $props();

  let highlighted = $state<{ source: string; html: string | null } | null>(null);
  let layer = $state<HTMLPreElement | null>(null);

  $effect(() => {
    const source = value;
    let active = true;
    void import('#lib/ui/code-highlight.js')
      .then(({ highlightCode }) => highlightCode(source, language))
      .then((html) => {
        if (active) highlighted = { source, html };
      })
      .catch((failure: unknown) => {
        console.debug('[sable code] highlighting unavailable', failure);
      });
    return () => {
      active = false;
    };
  });

  function paint(html: string | null, source: string) {
    return (node: HTMLElement) => {
      // The trailing newline keeps the layer as tall as a textarea ending in an empty line.
      if (html === null) node.textContent = `${source}\n`;
      else node.innerHTML = `${html}\n`;
    };
  }

  function follow(event: Event): void {
    const area = event.currentTarget as HTMLTextAreaElement;
    if (!layer) return;
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  }
</script>

<div
  class={['form-control', 'code-text-area', { 'form-control-error': error }]}
  style:--code-rows={rows}
>
  <pre class="layer" aria-hidden="true" bind:this={layer}><code
      {@attach paint(highlighted?.source === value ? highlighted.html : null, value)}></code></pre>
  <textarea bind:value {...rest} spellcheck={false} class="input" onscroll={follow}></textarea>
</div>

<style>
  .code-text-area {
    height: calc(var(--code-rows) * var(--code-line-height) + 2 * var(--space-200));
    min-height: calc(4 * var(--code-line-height) + 2 * var(--space-200));
    overflow: hidden;
    padding: 0;
    position: relative;
    resize: vertical;
    width: 100%;
  }

  .code-text-area:focus-within {
    --form-control-line: var(--primary-main);
    --form-control-ring: var(--border-width-600);
  }

  .layer,
  .input {
    box-sizing: border-box;
    font-family: var(--font-family-mono);
    font-size: max(var(--font-size-small), var(--font-size-input-min));
    font-variant-ligatures: none;
    inset: 0;
    line-height: var(--code-line-height);
    margin: 0;
    overflow-wrap: anywhere;
    padding: var(--space-200) var(--space-300);
    position: absolute;
    tab-size: 2;
    white-space: pre-wrap;
  }

  .layer {
    overflow: hidden;
    pointer-events: none;
    scrollbar-gutter: stable;
  }

  .layer code {
    font: inherit;
  }

  .input {
    background: transparent;
    border: 0;
    caret-color: var(--surface-on-container);
    color: transparent;
    outline: none;
    overflow: auto;
    resize: none;
    scrollbar-gutter: stable;
  }

  .input::selection {
    background: color-mix(in oklab, var(--primary-main) 35%, transparent);
    color: transparent;
  }

  .input:read-only {
    cursor: default;
  }
</style>
