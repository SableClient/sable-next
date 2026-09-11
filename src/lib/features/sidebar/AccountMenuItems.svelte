<script lang="ts">
  import '#lib/ui/primitives/menu.css';
  import type { SessionInfo } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { DropdownMenu } from 'bits-ui';
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
  <DropdownMenu.Item
    class="menu-item"
    disabled={switching}
    onclick={() => {
      onSwitch(account.account_id);
    }}
  >
    <Avatar size="small" id={account.user_id} name={account.user_id} />
    <span class="account-name">{account.user_id}</span>
  </DropdownMenu.Item>
{/each}
<DropdownMenu.Separator class="menu-separator" />
<DropdownMenu.Item class="menu-item" onclick={onProfile}
  >{$i18n.t('nav.editProfile')}</DropdownMenu.Item
>
<DropdownMenu.Item class="menu-item" onclick={onAddAccount}
  >{$i18n.t('nav.addAccount')}</DropdownMenu.Item
>
<DropdownMenu.Separator class="menu-separator" />
<DropdownMenu.Item class="menu-item menu-item-destructive" onclick={onLogout}
  >{$i18n.t('settings.logout')}</DropdownMenu.Item
>
