<script lang="ts">
  import type { SessionInfo } from '@/generated/SessionInfo';
  import { i18n } from '$lib/i18n';
  import { DropdownMenu } from 'bits-ui';

  interface Props {
    accounts: readonly SessionInfo[];
    currentAccountId?: string;
    switching: boolean;
    onSwitch: (accountId: string) => void;
    onAddAccount: () => void;
  }

  let { accounts, currentAccountId, switching, onSwitch, onAddAccount }: Props = $props();
</script>

{#each accounts as account (account.account_id)}
  <DropdownMenu.Item
    disabled={switching || account.account_id === currentAccountId}
    onclick={() => {
      onSwitch(account.account_id);
    }}>{account.user_id}</DropdownMenu.Item
  >
{/each}
<DropdownMenu.Item onclick={onAddAccount}>{$i18n.t('nav.addAccount')}</DropdownMenu.Item>
