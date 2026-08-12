<script lang="ts">
  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';

  interface Props {
    homeserver: string;
    userId: string;
    onSetUpProfile: () => void;
  }

  let { homeserver, userId, onSetUpProfile }: Props = $props();
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
    <Button onclick={onSetUpProfile}>{$i18n.t('auth.setUpProfile')}</Button>
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
    font-size: var(--font-size-large);
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
    padding: 0.625rem 0.75rem;
  }

  .summary-actions {
    display: grid;
    gap: 0.75rem;
  }
</style>
