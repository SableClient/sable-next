<script lang="ts">
  import type { PresenceView, SessionInfo } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import ActionMenuSub from '#lib/ui/primitives/ActionMenuSub.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

  const PRESENCE_OPTIONS: readonly PresenceView[] = ['online', 'unavailable', 'offline'];

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

  let presence = $derived(preferences.presence);
  let otherAccounts = $derived(
    accounts.filter((account) => account.account_id !== currentAccountId)
  );
</script>

{#if preferences.sendPresence}
  <ActionMenuSub label={$i18n.t('presence.title')}>
    {#snippet trigger()}
      <PresenceDot {presence} label={$i18n.t(`presence.${presence}`)} />
      <span class="presence-name">{$i18n.t(`presence.${presence}`)}</span>
    {/snippet}
    {#each PRESENCE_OPTIONS as option (option)}
      <ActionMenuItem
        checked={option === presence}
        onSelect={() => {
          setPreference('presence', option);
        }}
      >
        <PresenceDot presence={option} label={$i18n.t(`presence.${option}`)} />
        <span class="presence-name">{$i18n.t(`presence.${option}`)}</span>
      </ActionMenuItem>
    {/each}
  </ActionMenuSub>
  <ActionMenuSeparator />
{/if}
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
{#if otherAccounts.length > 0}
  <ActionMenuSeparator />
{/if}
<ActionMenuItem onSelect={onProfile}>{$i18n.t('nav.editProfile')}</ActionMenuItem>
<ActionMenuItem onSelect={onAddAccount}>{$i18n.t('nav.addAccount')}</ActionMenuItem>
<ActionMenuSeparator />
<ActionMenuItem destructive onSelect={onLogout}>{$i18n.t('settings.logout')}</ActionMenuItem>
