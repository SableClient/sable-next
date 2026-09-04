<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  function reloadApp(): void {
    void goto(resolve('/(app)/rooms'));
  }
</script>

<svelte:head>
  <title>{page.status} - Sable</title>
</svelte:head>

<main class="error-page" aria-labelledby="error-title">
  <div class="error-content">
    <p class="error-code" aria-hidden="true">{page.status}</p>
    <h1 id="error-title">{page.error?.message ?? $i18n.t('errors.pageTitle')}</h1>
    <Button class="error-reload" size="medium" onclick={reloadApp}
      >{$i18n.t('errors.reload')}</Button
    >
  </div>
</main>

<style>
  .error-page {
    align-items: center;
    background: var(--sable-surface-container);
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: var(--page-gutter);
  }

  .error-content {
    --error-code-size: clamp(4rem, 16vw, 8rem);

    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    max-width: 32rem;
    text-align: center;
  }

  .error-code {
    color: var(--sable-primary-main);
    font-size: var(--error-code-size);
    font-weight: var(--font-weight-bold);
    line-height: 0.9;
    margin: 0;
  }

  .error-content h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  :global(.error-reload) {
    min-width: 8rem;
  }
</style>
