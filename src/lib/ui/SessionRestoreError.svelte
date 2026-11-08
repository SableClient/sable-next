<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import BootFailureCard from './BootFailureCard.svelte';
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
    } catch (error) {
      console.warn('[sable auth] switching account failed', error);
      switchFailed = true;
    } finally {
      switching = false;
    }
  }

  async function signIn(query = 'addAccount=1'): Promise<void> {
    switching = true;
    switchFailed = false;
    try {
      await goto(resolve(`login?${query}`));
      core.beginSignInRecovery();
    } catch (error) {
      console.warn('[sable auth] opening sign-in failed', error);
      switchFailed = true;
    } finally {
      switching = false;
    }
  }
</script>

<BootFailureCard title={i18n.t('app.unableToStart')} detail={i18n.t('app.startFailed')}>
  <Button disabled={busy} onclick={() => void core.start()}>
    {i18n.t('common.tryAgain')}
  </Button>
  {#each core.accounts.filter((account) => !account.needs_reauth) as account (account.account_id)}
    <Button disabled={busy} onclick={() => void switchAccount(account.account_id)}>
      {i18n.t('nav.switchAccount')}: {account.user_id} ({account.device_id})
    </Button>
    <Button
      disabled={busy}
      onclick={() =>
        void signIn(
          `addAccount=1&reauth=${encodeURIComponent(account.account_id)}&server=${encodeURIComponent(account.homeserver)}`
        )}
    >
      {i18n.t('nav.accountSignInAgain')}: {account.user_id}
    </Button>
  {/each}
  {#if switchFailed}<p role="alert">{i18n.t('app.unableToStart')}</p>{/if}
  <p>{i18n.t('app.signInRecoveryHint')}</p>
  <Button disabled={busy} onclick={() => void signIn()}>{i18n.t('auth.signInTitle')}</Button>
</BootFailureCard>
