<script lang="ts">
  import { sanitizeMatrixHtml } from './sanitize-matrix-html';

  interface Props {
    body: string;
    formatted: string | null;
  }

  let { body, formatted }: Props = $props();
  let safeHtml = $derived(formatted === null ? null : sanitizeMatrixHtml(formatted));
</script>

<!-- `safeHtml` only comes from the allow-list sanitizer above. -->
{#if safeHtml === null}
  <p class="body">{body}</p>
{:else}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  <div class="formatted-body">{@html safeHtml}</div>
{/if}

<style>
  .body,
  .formatted-body :global(p) {
    line-height: var(--line-height-body);
    margin: 0;
    white-space: pre-wrap;
  }

  .formatted-body :global(blockquote) {
    border-left: 2px solid var(--sable-primary-main);
    margin: 0.25rem 0;
    padding-left: 0.5rem;
  }

  .formatted-body :global(pre) {
    overflow-x: auto;
  }
</style>
