<script lang="ts">
  import type { PresenceView, SessionInfo } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import type { AccountDirectory } from './account-directory.svelte.js';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import ActionMenuSub from '#lib/ui/primitives/ActionMenuSub.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import UserIcon from 'phosphor-svelte/lib/UserIcon';
  import PencilIcon from 'phosphor-svelte/lib/PencilIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import { useActionMenuSurface } from '#lib/ui/primitives/action-menu.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

  const PRESENCE_OPTIONS: readonly PresenceView[] = ['online', 'unavailable', 'offline'];

  interface Props {
    accounts: readonly SessionInfo[];
    profiles: AccountDirectory;
    currentAccountId?: string;
    switching: boolean;
    onSwitch: (accountId: string) => void;
    onProfile: () => void;
    onLogoutAccount: (accountId: string) => void;
    onReauth: (account: SessionInfo) => void;
    onLogout: () => void;
    onAddAccount: () => void;
    accountSwitching?: boolean;
  }

  let {
    accounts,
    profiles,
    currentAccountId,
    switching,
    onSwitch,
    onProfile,
    onLogoutAccount,
    onReauth,
    onLogout,
    onAddAccount,
    accountSwitching = true,
  }: Props = $props();
  let presence = $derived(preferences.presence);
  const surface = useActionMenuSurface();
</script>

{#if preferences.sendPresence}
  <ActionMenuSub class="presence-selector" label={$i18n.t('presence.title')}>
    {#snippet trigger()}
      <PresenceDot {presence} size="large" label={$i18n.t(`presence.${presence}`)} />
      <span class="presence-name">{$i18n.t(`presence.${presence}`)}</span>
    {/snippet}
    {#each PRESENCE_OPTIONS as option (option)}
      <ActionMenuItem
        checked={option === presence}
        onSelect={() => {
          setPreference('presence', option);
        }}
      >
        <PresenceDot presence={option} label={$i18n.t(`presence.${option}`)} size="medium" />
        <span class="presence-name">{$i18n.t(`presence.${option}`)}</span>
      </ActionMenuItem>
    {/each}
  </ActionMenuSub>
{/if}
<ActionMenuItem onSelect={onProfile}>
  <PencilIcon aria-hidden="true" />
  <span>{$i18n.t('nav.editProfile')}</span>
</ActionMenuItem>
<ActionMenuSeparator />
{#if accountSwitching}
  <ActionMenuSub label={$i18n.t('nav.switchAccount')} class="account-switcher-popover">
    {#snippet trigger()}
      <UserIcon aria-hidden="true" />
      <span>{$i18n.t('nav.switchAccount')}</span>
    {/snippet}
    <div class="account-list" role="group">
      {#each accounts as account (account.account_id)}
        {@const active = account.account_id === currentAccountId}
        {@const identity = profiles.identity(account.user_id)}
        <div
          class="account-row menu-item"
          aria-checked={active ? 'true' : undefined}
          data-active={active ? 'true' : undefined}
        >
          <button
            class="account-select"
            type="button"
            role="menuitemradio"
            aria-checked={active}
            disabled={active || switching}
            onclick={() => {
              if (account.needs_reauth) onReauth(account);
              else onSwitch(account.account_id);
              surface.close();
            }}
          >
            <Avatar
              size="small"
              id={account.user_id}
              name={identity.displayName}
              src={identity.avatarUrl}
            />
            <span class="account-identity">
              <strong>{account.user_id}</strong>
              <small>
                {#if account.needs_reauth}
                  {$i18n.t('nav.accountSignedOut')}
                {:else if active}
                  {$i18n.t('nav.currentAccount')}
                {:else}
                  {account.homeserver}
                {/if}
              </small>
            </span>
            {#if active}<CheckIcon
                class="active-account"
                aria-label={$i18n.t('nav.currentAccount')}
              />{/if}
          </button>
          <Button
            variant="danger"
            size="small"
            disabled={switching}
            onclick={() => {
              onLogoutAccount(account.account_id);
              surface.close();
            }}>{$i18n.t('settings.logout')}</Button
          >
        </div>
      {/each}
    </div>
    <ActionMenuSeparator />
    <ActionMenuItem onSelect={onAddAccount}>
      <PlusIcon aria-hidden="true" />
      <span>{$i18n.t('common.addAccount')}</span>
    </ActionMenuItem>
  </ActionMenuSub>
{/if}
<ActionMenuItem destructive onSelect={onLogout}>
  <SignOutIcon aria-hidden="true" />
  <span>{$i18n.t('settings.logout')}</span>
</ActionMenuItem>

<style>
  :global(.sidebar-popover .menu-item .presence-dot) {
    /* margin: (size of menu item icon - size of large presence dot) / 2 */
    margin: 0 calc((var(--size-x200) - var(--space-250)) / 2);
  }

  :global(.presence-selector .menu-item .presence-dot) {
    /* margin: (size of menu item icon - size of medium presence dot) / 2 */
    margin-right: calc((var(--size-x200) - var(--space-200)) / 2);
  }

  .account-row {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    min-height: var(--control-height-500);
    padding: var(--space-150) var(--space-200);
  }

  .account-list {
    display: grid;
    gap: var(--space-100);
    min-width: min(15rem, calc(100vw - 2rem));
    padding: 0;
  }

  .account-select {
    align-items: center;
    appearance: none;
    background: transparent;
    border: 0;
    border-radius: var(--radius-inner);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    gap: var(--space-200);
    min-width: 0;
    padding: 0;
    text-align: left;
  }

  .account-select:disabled {
    cursor: default;
  }

  .account-select:focus-visible,
  .account-row > :global(.btn):focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .account-identity {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .account-identity strong,
  .account-identity small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-identity strong {
    font-size: var(--font-size-label);
  }

  .account-identity small {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .account-row[data-active='true'] .account-identity small {
    color: inherit;
    opacity: var(--opacity-p500);
  }

  :global(.active-account) {
    color: var(--primary-on-container);
    flex: 0 0 auto;
    height: var(--size-x200);
    width: var(--size-x200);
  }
</style>
