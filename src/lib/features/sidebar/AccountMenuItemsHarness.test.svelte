<script lang="ts">
  import type { SessionInfo } from '#src/generated/protocol';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import AccountMenuItems from './AccountMenuItems.svelte';

  interface Props {
    accounts: SessionInfo[];
    onSwitch: (accountId: string) => void;
    onLogoutAccount: (accountId: string) => void;
  }

  let { accounts, onSwitch, onLogoutAccount }: Props = $props();
</script>

<ActionMenu label="Account options">
  {#snippet trigger({ props })}
    <button {...props} type="button" class="account-menu-trigger">Account options</button>
  {/snippet}
  <AccountMenuItems
    {accounts}
    currentAccountId="current"
    switching={false}
    {onSwitch}
    onProfile={() => {}}
    {onLogoutAccount}
    onLogout={() => {}}
    onAddAccount={() => {}}
  />
</ActionMenu>
