<script module lang="ts">
  export interface SkipAction {
    onclick: () => void;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';

  interface Props {
    skip: SkipAction | null;
    onLogout: () => void;
    loggingOut?: boolean;
    logoutFailed?: boolean;
  }

  let { skip, onLogout, loggingOut = false, logoutFailed = false }: Props = $props();
</script>

<div class="setup-actions">
  {#if skip}
    <AuthSecondaryAction
      label={i18n.t('auth.skipForNow')}
      onclick={skip.onclick}
      disabled={skip.disabled}
    />
  {/if}
  <AuthSecondaryAction
    label={i18n.t('settings.logout')}
    tone="danger"
    loading={loggingOut}
    onclick={onLogout}
  />
</div>
{#if logoutFailed}
  <p class="setup-actions-error" role="alert">{i18n.t('setup.logoutFailed')}</p>
{/if}

<style>
  .setup-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-400);
    justify-content: center;
  }

  .setup-actions-error {
    color: var(--crit-main);
    font-size: var(--font-size-label);
    margin: var(--space-100) 0 0;
    text-align: center;
  }
</style>
