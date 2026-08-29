<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    homeserver: string;
    userId: string;
    onContinue: () => void;
  }

  let { homeserver, userId, onContinue }: Props = $props();
</script>

<section class="auth-card-surface summary-card" aria-labelledby="account-created-title">
  <p class="eyebrow">
    {$i18n.t('auth.accountCreated')}
  </p>
  <h2 id="account-created-title">
    {$i18n.t('auth.accountReady')}
  </h2>
  <p>{$i18n.t('auth.accountProviderSummary', { server: homeserver })}</p>
  <p class="user-id">{userId}</p>
  <div class="summary-actions">
    <Button onclick={onContinue}>{$i18n.t('auth.continue')}</Button>
  </div>
</section>

<style>
  .summary-card {
    min-width: 0;
  }

  .eyebrow {
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
  }

  .summary-card h2 {
    font-size: var(--font-size-heading);
  }

  .summary-card p:not(.eyebrow, .user-id) {
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .user-id {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    overflow-wrap: anywhere;
    padding: var(--space-250) var(--space-300);
  }

  .summary-actions {
    display: grid;
    gap: var(--space-300);
  }
</style>
