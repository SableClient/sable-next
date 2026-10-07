<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { skipV1Migration } from '#lib/migrations/v1/migration.js';
  import Button from './primitives/Button.svelte';

  const core = useCoreClient();
  let switching = $state(false);
  let switchFailed = $state(false);
  let busy = $derived(core.status === 'starting' || switching);

  async function switchAccount(accountId: string): Promise<void> {
    switching = true;
    switchFailed = false;
    try {
      await core.switchAccount(accountId);
      await goto(resolve('/(app)/rooms'));
    } catch {
      switchFailed = true;
    } finally {
      switching = false;
    }
  }

  async function skipMigration(): Promise<void> {
    switching = true;
    switchFailed = false;
    try {
      await skipV1Migration();
      await core.start();
    } catch {
      switchFailed = true;
    } finally {
      switching = false;
    }
  }

  async function signIn(): Promise<void> {
    switching = true;
    switchFailed = false;
    try {
      await goto(resolve('login?addAccount=1'));
      core.beginSignInRecovery();
    } catch {
      switchFailed = true;
    } finally {
      switching = false;
    }
  }
</script>

<main class="restore-error" aria-labelledby="restore-error-title">
  <div class="restore-card" role="alert">
    <h1 id="restore-error-title">{$i18n.t('app.unableToStart')}</h1>
    <p>{$i18n.t(core.migrationFailed ? 'app.migrationFailed' : 'app.startFailed')}</p>
    {#if core.migrationError}<p>{core.migrationError}</p>{/if}
    <Button disabled={busy} onclick={() => void core.start()}>
      {$i18n.t('common.tryAgain')}
    </Button>
    {#each core.accounts.filter((account) => !account.needs_reauth) as account (account.account_id)}
      <Button disabled={busy} onclick={() => void switchAccount(account.account_id)}>
        {$i18n.t('nav.switchAccount')}: {account.user_id} ({account.device_id})
      </Button>
    {/each}
    {#if switchFailed}<p role="alert">{$i18n.t('app.unableToStart')}</p>{/if}
    {#if core.migrationFailed}
      <p>{$i18n.t('app.skipMigrationHint')}</p>
      <Button disabled={busy} onclick={() => void skipMigration()}>
        {$i18n.t('app.skipMigration')}
      </Button>
    {:else}
      <p>{$i18n.t('app.signInRecoveryHint')}</p>
      <Button disabled={busy} onclick={() => void signIn()}>{$i18n.t('auth.signInTitle')}</Button>
    {/if}
  </div>
</main>

<style>
  .restore-error {
    align-items: center;
    background: var(--surface-container);
    box-sizing: border-box;
    color: var(--surface-on-container);
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: var(--space-700) var(--space-600);
  }

  .restore-card {
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
  p {
    margin: 0;
  }

  h1 {
    font-size: var(--font-size-heading);
  }

  p {
    color: var(--surface-var-on-container);
    line-height: var(--line-height-body);
  }
</style>
