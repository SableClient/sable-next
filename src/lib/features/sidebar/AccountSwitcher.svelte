<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { DropdownMenu, Tooltip } from 'bits-ui';
  import AccountMenuItems from './AccountMenuItems.svelte';
  import './sidebar-tools.css';

  type Mode = 'mobile' | 'compact' | 'desktop';

  interface Props {
    mode: Mode;
  }

  let { mode }: Props = $props();
  const core = useCoreClient();
  let switching = $state(false);
  let initials = $derived(
    core.session ? core.session.user_id.replace(/^@/, '').charAt(0).toUpperCase() || '?' : '?'
  );

  async function switchAccount(accountId: string): Promise<void> {
    if (accountId === core.session?.account_id || switching) return;
    switching = true;
    try {
      await core.switchAccount(accountId);
      await goto(resolve('/home'));
    } finally {
      switching = false;
    }
  }

  function openAddAccount(): void {
    void goto(resolve('/login?addAccount=1'));
  }
</script>

{#if mode === 'mobile'}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="quick-tool mobile-tool" aria-label={$i18n.t('nav.switchAccount')}>
      <span class="avatar" aria-hidden="true">{initials}</span>
      <span>{$i18n.t('nav.account')}</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="account-popover" side="top" sideOffset={8}>
      <AccountMenuItems
        accounts={core.accounts}
        currentAccountId={core.session?.account_id}
        {switching}
        onSwitch={switchAccount}
        onAddAccount={openAddAccount}
      />
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  {#snippet profileTrigger({ props }: { props: Record<string, unknown> })}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        {...props}
        class="quick-tool {mode === 'compact' ? 'compact-tool' : 'desktop-tool'}"
        aria-label={$i18n.t('nav.switchAccount')}
      >
        <span class="avatar" aria-hidden="true">{initials}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="account-popover"
        side={mode === 'compact' ? 'right' : 'top'}
        sideOffset={8}
      >
        <AccountMenuItems
          accounts={core.accounts}
          currentAccountId={core.session?.account_id}
          {switching}
          onSwitch={switchAccount}
          onAddAccount={openAddAccount}
        />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}
  <Tooltip.Root>
    <Tooltip.Trigger child={profileTrigger} />
    <Tooltip.Content class="tooltip" side={mode === 'compact' ? 'right' : 'top'} sideOffset={8}
      >{$i18n.t('nav.switchAccount')}</Tooltip.Content
    >
  </Tooltip.Root>
{/if}
