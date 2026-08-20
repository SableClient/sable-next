<script lang="ts">
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

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

<div class="auth-status-slot" aria-live="polite">
  {#if loading && loadingMessage}
    <div class="auth-status-message auth-status-loading">
      <Spinner small />
      {loadingMessage}
    </div>
  {:else if message}
    <p
      class="auth-status-message auth-status-{tone}"
      class:multiline
      {id}
      role={tone === 'error' ? 'alert' : 'status'}
      title={message}
    >
      {message}
    </p>
  {/if}
</div>

<style>
  .auth-status-slot {
    align-items: center;
    display: flex;
    height: calc(var(--font-size-small) * var(--line-height-body));
    overflow: hidden;
  }

  .auth-status-message {
    margin: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .auth-status-loading {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    line-height: var(--line-height-body);
  }

  .auth-status-error,
  .auth-status-muted {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .auth-status-error {
    color: var(--sable-crit-main);
  }

  .auth-status-muted {
    color: var(--sable-sec-main);
  }

  .auth-status-error.multiline,
  .auth-status-muted.multiline {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  @keyframes error-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .auth-status-error {
      animation: error-in var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
