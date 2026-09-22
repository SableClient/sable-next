<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { ProfileView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { logoutWithPush } from '#lib/features/notifications/web-push.js';
  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import AccountMenuItems from './AccountMenuItems.svelte';
  import { AccountDirectory } from './account-directory.svelte.js';
  import '#lib/ui/primitives/nav-tab.css';
  import './sidebar-tools.css';

  type Mode = 'mobile' | 'compact' | 'desktop';

  interface Props {
    mode: Mode;
  }

  let { mode }: Props = $props();
  const core = useCoreClient();
  const presenceStore = usePresenceStore();
  const accountProfiles = new AccountDirectory(core);
  let switching = $state(false);
  let logoutAccountId = $state<string | null>(null);
  let accountToLogout = $derived(
    core.accounts.find((account) => account.account_id === logoutAccountId) ?? null
  );
  let profile = $state<ProfileView | null>(null);
  let activeProfile = $derived(profile?.user_id === core.session?.user_id ? profile : null);
  let displayName = $derived(activeProfile?.display_name ?? core.session?.user_id ?? '?');
  let userStatus = $derived(
    resolveUserStatus(activeProfile, presenceStore.get(core.session?.user_id ?? ''))
  );
  let avatarUrl = $derived(activeProfile?.avatar_url ?? null);
  let ownPresence = $derived(preferences.sendPresence ? preferences.presence : null);

  $effect(() => {
    const userId = core.session?.user_id;
    if (!userId) return;
    let cancelled = false;
    void core.userProfile(userId).then(
      (nextProfile) => {
        if (!cancelled) profile = nextProfile;
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  });

  async function switchAccount(accountId: string): Promise<void> {
    if (accountId === core.session?.account_id || switching) return;
    switching = true;
    try {
      await core.switchAccount(accountId);
      await goto(resolve('/(app)/rooms'));
    } finally {
      switching = false;
    }
  }

  function openAddAccount(): void {
    void goto(resolve('login?addAccount=1'));
  }

  function openProfile(): void {
    void goto(resolve('settings/account'));
  }

  async function logoutAccount(accountId: string): Promise<void> {
    if (switching) return;

    switching = true;
    try {
      if (accountId !== core.session?.account_id) await core.switchAccount(accountId);
      await logoutWithPush(core, pushOverride());
      if (core.status === 'ready') await goto(resolve('/(app)/rooms'));
    } finally {
      switching = false;
    }
  }

  function requestLogout(accountId: string): void {
    logoutAccountId = accountId;
  }

  function logout(): void {
    void logoutWithPush(core, pushOverride());
  }
</script>

{#snippet ownAvatar()}
  <Avatar size="small" src={avatarUrl} name={displayName} alt={displayName} />
  {#if ownPresence}
    <PresenceDot
      presence={ownPresence}
      label={$i18n.t(`presence.${ownPresence}`)}
      class="account-presence"
      size="large"
    />
  {/if}
{/snippet}

{#if mode === 'mobile'}
  <a
    class="quick-tool mobile-tool account-tool selection-layer"
    href={resolve('/(app)/profile')}
    aria-label={$i18n.t('nav.manageAccounts')}
    aria-current={page.url.pathname === '/profile' ? 'page' : undefined}
  >
    {@render ownAvatar()}
  </a>
{:else}
  {#snippet profileTrigger({ props: tooltipProps }: { props: Record<string, unknown> })}
    <ActionMenu
      label={$i18n.t('nav.switchAccount')}
      class="account-popover"
      side={mode === 'compact' ? 'right' : 'top'}
      align={mode === 'compact' ? 'center' : 'start'}
      sideOffset={8}
    >
      {#snippet trigger({ props })}
        <button
          {...tooltipProps}
          {...props}
          type="button"
          class="quick-tool nav-tab nav-tab-outlined selection-open selection-layer {mode ===
          'compact'
            ? 'compact-tool nav-tab-side'
            : 'desktop-tool nav-tab-bottom'}"
          aria-label={$i18n.t('nav.switchAccount')}
        >
          {@render ownAvatar()}
        </button>
      {/snippet}
      <ProfileCard
        class="account-profile-header"
        {displayName}
        userId={core.session?.user_id ?? ''}
        {avatarUrl}
        color={activeProfile?.hero_color ?? 'var(--primary-container)'}
        heroColor={activeProfile?.hero_color}
        heroBrightness={activeProfile?.hero_brightness}
        bannerUrl={activeProfile?.banner_url}
        status={userStatus?.text}
        statusEmoji={userStatus?.emoji}
        nameColorLight={activeProfile?.name_color_light}
        nameColorDark={activeProfile?.name_color_dark}
      />
      <AccountMenuItems
        accounts={core.accounts}
        profiles={accountProfiles}
        currentAccountId={core.session?.account_id}
        {switching}
        onSwitch={switchAccount}
        onProfile={openProfile}
        onLogoutAccount={requestLogout}
        onLogout={logout}
        onAddAccount={openAddAccount}
      />
    </ActionMenu>
  {/snippet}
  <Tooltip
    label={$i18n.t('nav.switchAccount')}
    side={mode === 'compact' ? 'right' : 'top'}
    trigger={profileTrigger}
  />
{/if}

<DialogFrame
  open={accountToLogout !== null}
  variant="verification"
  label={$i18n.t('settings.logout')}
  onOpenChange={(open) => {
    if (!open && !switching) logoutAccountId = null;
  }}
>
  {#if accountToLogout}
    <div class="logout-dialog">
      <h2>{$i18n.t('settings.logout')}</h2>
      <p>{accountToLogout.user_id}</p>
      <div class="dialog-actions">
        <Button variant="ghost" disabled={switching} onclick={() => (logoutAccountId = null)}
          >{$i18n.t('settings.cancel')}</Button
        >
        <Button
          variant="danger"
          loading={switching}
          onclick={() => {
            const accountId = accountToLogout?.account_id;
            if (accountId) void logoutAccount(accountId).then(() => (logoutAccountId = null));
          }}>{$i18n.t('settings.logout')}</Button
        >
      </div>
    </div>
  {/if}
</DialogFrame>

<style>
  .account-tool {
    position: relative;
  }

  :global(.quick-tool > .account-presence) {
    bottom: -0.125rem;
    position: absolute;
    right: -0.125rem;
  }

  .logout-dialog {
    display: grid;
    gap: var(--space-300);
  }

  .logout-dialog h2,
  .logout-dialog p {
    margin: 0;
  }

  .dialog-actions {
    display: flex;
    gap: var(--space-200);
    justify-content: end;
  }
</style>
