<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    detail: string;
    children: Snippet;
  }

  let { title, detail, children }: Props = $props();
</script>

<main class="boot-failure" aria-labelledby="boot-failure-title">
  <div class="boot-failure-card" role="alert">
    <h1 id="boot-failure-title">{title}</h1>
    <p>{detail}</p>
    {@render children()}
  </div>
</main>

<style>
  .boot-failure {
    align-items: center;
    background: var(--surface-container);
    box-sizing: border-box;
    color: var(--surface-on-container);
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: var(--space-700) var(--space-600);
  }

  .boot-failure-card {
    align-items: center;
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    box-sizing: border-box;
    color: var(--bg-on-container);
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    max-width: 28rem;
    padding: var(--space-700);
    text-align: center;
    width: 100%;
  }

  h1,
  .boot-failure-card :global(p) {
    margin: 0;
  }

  h1 {
    font-size: var(--font-size-heading);
  }

  .boot-failure-card :global(p) {
    color: var(--surface-var-on-container);
    line-height: var(--line-height-body);
  }
</style>
