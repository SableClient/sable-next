<script lang="ts">
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    loading?: boolean;
    loadingMessage?: string;
    message?: string | null;
    id?: string;
    multiline?: boolean;
    tone?: 'error' | 'muted';
  }

  let {
    loading = false,
    loadingMessage,
    message,
    id,
    multiline = false,
    tone = 'error',
  }: Props = $props();
</script>

{#snippet statusMessage(text: string)}
  <Tooltip label={text} {multiline}>
    {#snippet trigger({ props })}
      <p {...props} class={[`auth-status-message auth-status-${tone}`, { multiline }]} {id}>
        {text}
      </p>
    {/snippet}
  </Tooltip>
{/snippet}

<div class="auth-status-slot">
  <div class="auth-status-announcement" role="status" aria-atomic="true">
    {#if loading && loadingMessage}
      <div class="auth-status-message auth-status-loading">
        <Spinner small />
        {loadingMessage}
      </div>
    {:else if message && tone === 'muted'}
      {@render statusMessage(message)}
    {/if}
  </div>
  <div class="auth-status-announcement" role="alert" aria-atomic="true">
    {#if !(loading && loadingMessage) && message && tone === 'error'}
      {@render statusMessage(message)}
    {/if}
  </div>
</div>

<style>
  .auth-status-slot {
    align-items: center;
    display: flex;
    min-height: calc(var(--font-size-small) * var(--line-height-body));
    overflow: hidden;
  }

  .auth-status-message {
    margin: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .auth-status-announcement {
    max-width: 100%;
    min-width: 0;
  }

  .auth-status-loading {
    align-items: center;
    color: var(--sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    line-height: var(--line-height-body);
  }

  .auth-status-error,
  .auth-status-muted {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .auth-status-error {
    color: var(--crit-main);
  }

  .auth-status-muted {
    color: var(--sec-main);
  }

  .auth-status-error.multiline,
  .auth-status-muted.multiline {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  @keyframes error-in {
    0% {
      opacity: 0;
      transform: translateX(calc(var(--space-200) * var(--inline-sign)));
    }

    40% {
      transform: translateX(calc(var(--space-150) * -1 * var(--inline-sign)));
    }

    70% {
      transform: translateX(calc(var(--space-150) * var(--inline-sign)));
    }

    100% {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .auth-status-error {
      animation: error-in var(--duration-fast) var(--ease-smooth-out);
    }
  }
</style>
