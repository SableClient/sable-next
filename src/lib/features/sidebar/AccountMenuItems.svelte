<script lang="ts">
  import type { SessionInfo } from '@/generated/SessionInfo';
  import { i18n } from '$lib/i18n';
  import { DropdownMenu } from 'bits-ui';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import StatusBadge from '$lib/ui/primitives/StatusBadge.svelte';

  interface Props {
    accounts: readonly SessionInfo[];
    currentAccountId?: string;
    switching: boolean;
    onSwitch: (accountId: string) => void;
    onProfile: () => void;
    onSettings: () => void;
    onAddAccount: () => void;
  }

  let {
    accounts,
    currentAccountId,
    switching,
    onSwitch,
    onProfile,
    onSettings,
    onAddAccount,
  }: Props = $props();

  function initials(userId: string): string {
    return userId.replace(/^@/, '').slice(0, 1).toUpperCase() || '?';
  }
</script>

{#each accounts as account (account.account_id)}
  <DropdownMenu.Item
    disabled={switching || account.account_id === currentAccountId}
    onclick={() => {
      onSwitch(account.account_id);
    }}
  >
    <Avatar size="small" initials={initials(account.user_id)} />
    <span class="account-name">{account.user_id}</span>
    {#if account.account_id === currentAccountId}
      <StatusBadge label={$i18n.t('nav.currentAccount')} variant="primary" />
    {/if}
  </DropdownMenu.Item>
{/each}
<DropdownMenu.Separator class="account-separator" />
<DropdownMenu.Item onclick={onProfile}>{$i18n.t('nav.profile')}</DropdownMenu.Item>
<DropdownMenu.Item onclick={onSettings}>{$i18n.t('nav.settings')}</DropdownMenu.Item>
<DropdownMenu.Item onclick={onAddAccount}>{$i18n.t('nav.addAccount')}</DropdownMenu.Item>
