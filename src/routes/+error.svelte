<script lang="ts">
  import * as Sentry from '@sentry/sveltekit';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { forgeIssueUrl, openForgeIssueUrl } from '#lib/features/bug-report/forge.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';

  let details = $state('');
  let detailsSent = $state(false);

  let crash = $derived(page.error?.stack !== undefined || page.error?.eventId !== undefined);
  let eventId = $derived(page.error?.eventId);

  function reloadApp(): void {
    void goto(resolve('/(app)/rooms'));
  }

  function reportOnForge(): void {
    const error = page.error;
    if (!error) return;
    const url = forgeIssueUrl('bug', `Crash: ${error.message}`, {
      description: error.message,
      context: details.trim(),
      info: ['```', error.stack ?? error.message, '```'].join('\n'),
    });
    void openForgeIssueUrl(url);
  }

  function sendDetails(): void {
    if (eventId === undefined || details.trim() === '') return;
    Sentry.captureFeedback({
      message: details.trim(),
      name: 'Crash report follow-up',
      associatedEventId: eventId,
    });
    detailsSent = true;
  }
</script>

<svelte:head>
  <title>{page.status} - Sable</title>
</svelte:head>

<main class="error-page" aria-labelledby="error-title">
  <div class="error-content">
    <p class="error-code" aria-hidden="true">{page.status}</p>
    <h1 id="error-title">{page.error?.message ?? $i18n.t('errors.pageTitle')}</h1>

    {#if crash}
      <p class="crash-note">
        {eventId === undefined
          ? $i18n.t('errors.crashUnreported')
          : $i18n.t('errors.crashReported')}
      </p>

      {#if detailsSent}
        <p class="crash-note">{$i18n.t('errors.detailsThanks')}</p>
      {:else}
        <TextArea
          bind:value={details}
          rows={3}
          aria-label={$i18n.t('errors.detailsLabel')}
          placeholder={$i18n.t('errors.detailsPlaceholder')}
        />
        {#if eventId !== undefined}
          <Button size="medium" disabled={details.trim() === ''} onclick={sendDetails}>
            {$i18n.t('errors.sendDetails')}
          </Button>
        {/if}
      {/if}

      <Button size="medium" onclick={reportOnForge}>{$i18n.t('errors.reportIssue')}</Button>

      {#if page.error?.stack}
        <details class="stack">
          <summary>{$i18n.t('errors.showStack')}</summary>
          <pre>{page.error.stack}</pre>
        </details>
      {/if}
    {/if}

    <Button class="error-reload" size="medium" onclick={reloadApp}
      >{$i18n.t('errors.reload')}</Button
    >
  </div>
</main>

<style>
  .error-page {
    align-items: center;
    background: var(--surface-container);
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
    width: 100%;
  }

  .error-code {
    color: var(--primary-main);
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

  .crash-note {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .error-content :global(.text-area) {
    width: 100%;
  }

  .stack {
    text-align: start;
    width: 100%;
  }

  .stack pre {
    background: var(--surface-container-active);
    border-radius: var(--radius);
    margin: var(--space-200) 0 0;
    max-height: 12rem;
    overflow: auto;
    overflow-wrap: anywhere;
    padding: var(--space-300);
    white-space: pre-wrap;
  }

  :global(.error-reload) {
    min-width: 8rem;
  }
</style>
