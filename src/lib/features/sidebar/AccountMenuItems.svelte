<script lang="ts">
  import type { SessionInfo } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    accounts: readonly SessionInfo[];
    currentAccountId?: string;
    switching: boolean;
    onSwitch: (accountId: string) => void;
    onProfile: () => void;
    onLogout: () => void;
    onAddAccount: () => void;
  }

  let {
    accounts,
    currentAccountId,
    switching,
    onSwitch,
    onProfile,
    onLogout,
    onAddAccount,
  }: Props = $props();

  let otherAccounts = $derived(
    accounts.filter((account) => account.account_id !== currentAccountId)
  );
</script>

{#each otherAccounts as account (account.account_id)}
  <ActionMenuItem
    disabled={switching}
    onSelect={() => {
      onSwitch(account.account_id);
    }}
  >
    <Avatar size="small" id={account.user_id} name={account.user_id} />
    <span class="account-name">{account.user_id}</span>
  </ActionMenuItem>
{/each}
<ActionMenuSeparator />
<ActionMenuItem onSelect={onProfile}>{$i18n.t('nav.editProfile')}</ActionMenuItem>
<ActionMenuItem onSelect={onAddAccount}>{$i18n.t('nav.addAccount')}</ActionMenuItem>
<ActionMenuSeparator />
<ActionMenuItem destructive onSelect={onLogout}>{$i18n.t('settings.logout')}</ActionMenuItem>
