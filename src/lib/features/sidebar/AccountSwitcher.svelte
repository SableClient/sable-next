<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { ProfileView } from '@/generated/ProfileView';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { DropdownMenu } from 'bits-ui';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import ProfileCard from '$lib/ui/primitives/ProfileCard.svelte';
  import Tooltip from '$lib/ui/primitives/Tooltip.svelte';
  import AccountMenuItems from './AccountMenuItems.svelte';
  import './sidebar-tools.css';

  type Mode = 'mobile' | 'compact' | 'desktop';

  interface Props {
    mode: Mode;
  }

  let { mode }: Props = $props();
  const core = useCoreClient();
  let switching = $state(false);
  let profile = $state<ProfileView | null>(null);
  let initials = $derived(
    core.session ? core.session.user_id.replace(/^@/, '').charAt(0).toUpperCase() || '?' : '?'
  );
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
      await goto(resolve('/home'));
    } finally {
      switching = false;
    }
  }

  function openAddAccount(): void {
    void goto(resolve('/login?addAccount=1'));
  }

  function openProfile(): void {
    void goto(resolve('/profile'));
  }

  function logout(): void {
    void core.logout();
  }
</script>

{#if mode === 'mobile'}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="quick-tool mobile-tool sable-selection-layer"
      aria-label={$i18n.t('nav.switchAccount')}
    >
      <Avatar size="small" src={avatarUrl} {initials} alt={displayName} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="account-popover" side="top" sideOffset={8}>
      <ProfileCard
        class="account-profile-header"
        {displayName}
        userId={core.session?.user_id ?? ''}
        {avatarUrl}
        color={activeProfile?.hero_color ?? 'var(--sable-primary-container)'}
        bannerUrl={activeProfile?.banner_url}
        status={activeProfile?.status}
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
{:else}
  {#snippet profileTrigger({ props }: { props: Record<string, unknown> })}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        {...props}
        class="quick-tool sable-selection-layer {mode === 'compact'
          ? 'compact-tool'
          : 'desktop-tool'}"
        aria-label={$i18n.t('nav.switchAccount')}
      >
        <Avatar size="small" src={avatarUrl} {initials} alt={displayName} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="account-popover"
        side={mode === 'compact' ? 'right' : 'top'}
        sideOffset={8}
      >
        <ProfileCard
          class="account-profile-header"
          {displayName}
          userId={core.session?.user_id ?? ''}
          {avatarUrl}
          color={activeProfile?.hero_color ?? 'var(--sable-primary-container)'}
          bannerUrl={activeProfile?.banner_url}
          status={activeProfile?.status}
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
