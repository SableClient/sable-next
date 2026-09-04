<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { ProfileView } from '#src/generated/ProfileView';
  import { useCoreClient } from '#lib/core/context.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { logoutWithPush } from '#lib/features/notifications/web-push.js';
  import { i18n } from '#lib/i18n.js';
  import { DropdownMenu } from 'bits-ui';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import AccountMenuItems from './AccountMenuItems.svelte';
  import '#lib/ui/primitives/nav-tab.css';
  import './sidebar-tools.css';

  type Mode = 'mobile' | 'compact' | 'desktop';

  interface Props {
    mode: Mode;
  }

  let { mode }: Props = $props();
  const core = useCoreClient();
  let switching = $state(false);
  let profile = $state<ProfileView | null>(null);
  let activeProfile = $derived(profile?.user_id === core.session?.user_id ? profile : null);
  let displayName = $derived(activeProfile?.display_name ?? core.session?.user_id ?? '?');
  let avatarUrl = $derived(activeProfile?.avatar_url ?? null);

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

  function openAccounts(): void {
    void goto(resolve('profile'));
  }

  function logout(): void {
    void logoutWithPush(core, pushOverride());
  }
</script>

{#if mode === 'mobile'}
  <button
    class="quick-tool mobile-tool sable-selection-layer"
    type="button"
    aria-label={$i18n.t('nav.account')}
    onclick={openAccounts}
  >
    <Avatar size="small" src={avatarUrl} name={displayName} alt={displayName} />
  </button>
{:else}
  {#snippet profileTrigger({ props }: { props: Record<string, unknown> })}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        {...props}
        class="quick-tool sable-nav-tab sable-nav-tab-outlined sable-open sable-selection-layer {mode ===
        'compact'
          ? 'compact-tool sable-nav-tab-side'
          : 'desktop-tool sable-nav-tab-bottom'}"
        aria-label={$i18n.t('nav.switchAccount')}
      >
        <Avatar size="small" src={avatarUrl} name={displayName} alt={displayName} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="sable-menu account-popover"
        side={mode === 'compact' ? 'right' : 'top'}
        sideOffset={8}
      >
        <ProfileCard
          class="account-profile-header"
          {displayName}
          userId={core.session?.user_id ?? ''}
          {avatarUrl}
          color={activeProfile?.hero_color ?? 'var(--sable-primary-container)'}
          heroColor={activeProfile?.hero_color}
          heroBrightness={activeProfile?.hero_brightness}
          bannerUrl={activeProfile?.banner_url}
          status={activeProfile?.status?.text}
          statusEmoji={activeProfile?.status?.emoji}
          nameColorLight={activeProfile?.name_color_light}
          nameColorDark={activeProfile?.name_color_dark}
        />
        <AccountMenuItems
          accounts={core.accounts}
          currentAccountId={core.session?.account_id}
          {switching}
          onSwitch={switchAccount}
          onProfile={openProfile}
          onLogout={logout}
          onAddAccount={openAddAccount}
        />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}
  <Tooltip
    label={$i18n.t('nav.switchAccount')}
    side={mode === 'compact' ? 'right' : 'top'}
    trigger={profileTrigger}
  />
{/if}
