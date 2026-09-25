<script lang="ts">
  import type { SessionInfo } from '#src/generated/protocol';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import AccountMenuItems from './AccountMenuItems.svelte';
  import { AccountDirectory } from './account-directory.svelte.js';

  interface Props {
    accounts: SessionInfo[];
    profiles: AccountDirectory;
    onSwitch: (accountId: string) => void;
    onLogoutAccount: (accountId: string) => void;
    onReauth?: (account: SessionInfo) => void;
    accountSwitching?: boolean;
  }

  let {
    accounts,
    profiles,
    onSwitch,
    onLogoutAccount,
    onReauth = () => {},
    accountSwitching,
  }: Props = $props();
</script>

<ActionMenu label="Account options">
  {#snippet trigger({ props })}
    <button {...props} type="button" class="account-menu-trigger">Account options</button>
  {/snippet}
  <AccountMenuItems
    {accounts}
    {profiles}
    currentAccountId="current"
    switching={false}
    {onSwitch}
    onProfile={() => {}}
    {onLogoutAccount}
    {onReauth}
    onLogout={() => {}}
    onAddAccount={() => {}}
    {accountSwitching}
  />
</ActionMenu>
