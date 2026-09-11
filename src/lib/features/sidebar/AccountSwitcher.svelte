<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { ProfileView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { logoutWithPush } from '#lib/features/notifications/web-push.js';
  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
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
  const presenceStore = usePresenceStore();
  let switching = $state(false);
  let profile = $state<ProfileView | null>(null);
  let activeProfile = $derived(profile?.user_id === core.session?.user_id ? profile : null);
  let displayName = $derived(activeProfile?.display_name ?? core.session?.user_id ?? '?');
  let userStatus = $derived(
    resolveUserStatus(activeProfile, presenceStore.get(core.session?.user_id ?? ''))
  );
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
    class="quick-tool mobile-tool selection-layer"
    type="button"
    aria-label={$i18n.t('nav.account')}
    onclick={openAccounts}
  >
    <Avatar size="small" src={avatarUrl} name={displayName} alt={displayName} />
  </button>
{:else}
  {#snippet profileTrigger({ props: tooltipProps }: { props: Record<string, unknown> })}
    <ActionMenu
      label={$i18n.t('nav.switchAccount')}
      class="account-popover"
      side={mode === 'compact' ? 'right' : 'top'}
      align="center"
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
          <Avatar size="small" src={avatarUrl} name={displayName} alt={displayName} />
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
        currentAccountId={core.session?.account_id}
        {switching}
        onSwitch={switchAccount}
        onProfile={openProfile}
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
