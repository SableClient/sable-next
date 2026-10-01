<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { SignOutGuard } from '#lib/features/sidebar/sign-out-guard.svelte.js';
  import SignOutWarningDialog from '#lib/features/sidebar/SignOutWarningDialog.svelte';
  import Button from './primitives/Button.svelte';

  const core = useCoreClient();
  const signOut = new SignOutGuard(core);
  let busy = $state(false);
  let failed = $state(false);

  async function switchAccount(accountId: string): Promise<void> {
    busy = true;
    failed = false;
    try {
      await core.switchAccount(accountId);
      await goto(resolve('/(app)/rooms'));
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await core.logout();
      await goto(resolve(core.session ? '/(app)/rooms' : '/(auth)/login'));
    } catch {
      failed = true;
    }
  }
</script>

<main class="locked" aria-labelledby="account-locked-title">
  <h1 id="account-locked-title">{$i18n.t('app.accountLocked')}</h1>
  <p>{core.session?.user_id}</p>
  <p>{$i18n.t('app.accountLockedDetail')}</p>
  {#each core.accounts.filter((account) => !account.needs_reauth && account.account_id !== core.session?.account_id) as account (account.account_id)}
    <Button disabled={busy} onclick={() => void switchAccount(account.account_id)}>
      {$i18n.t('nav.switchAccount')}: {account.user_id}
    </Button>
  {/each}
  <Button
    disabled={busy || signOut.checking || signOut.signingOut}
    onclick={() => void signOut.request(logout)}>{$i18n.t('settings.logout')}</Button
  >
  {#if failed}<p role="alert">{$i18n.t('errors.coreError')}</p>{/if}
</main>
<SignOutWarningDialog guard={signOut} />

<style>
  .locked {
    align-items: center;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    justify-content: center;
    min-height: 100dvh;
    padding: var(--space-700);
    text-align: center;
  }

  h1,
  p {
    margin: 0;
    max-width: 28rem;
  }

  p {
    color: var(--surface-var-on-container);
  }
</style>
