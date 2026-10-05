<script lang="ts">
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';
  import type { PerMessageProfileView, ProfileView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import UserSupporterBadge from '#lib/supporter/UserSupporterBadge.svelte';
  import { profileSupporterAppearance } from '#lib/supporter/variants.js';

  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Pill from '#lib/ui/primitives/Pill.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';

  import { senderColor } from '../timeline/timeline-format';

  interface Props {
    profile: PerMessageProfileView;
    accountId: string;
    accountName: string;
    accountProfile?: ProfileView | null;
    variant?: 'popover' | 'sheet';
    onOpenAccount?: () => void;
    onAvatarClick?: (source: string, displayName: string) => void;
  }

  let {
    profile,
    accountId,
    accountName,
    accountProfile = null,
    variant = 'popover',
    onOpenAccount,
    onAvatarClick,
  }: Props = $props();
  const core = useCoreClient();
  let ownerProfile = $derived(accountProfile?.user_id === accountId ? accountProfile : null);
  let displayName = $derived(profile.display_name ?? accountName);
  let accountLabel = $derived(displayName === accountName ? accountId : accountName);
</script>

<ProfileCard
  {displayName}
  {variant}
  userId={accountLabel}
  avatarUrl={profile.avatar_url}
  avatarLabel={$i18n.t('timeline.profileAvatar', { name: displayName })}
  {onAvatarClick}
  color={senderColor(profile.id ?? displayName)}
  nameColorLight={profile.color_on_light}
  nameColorDark={profile.color_on_dark}
>
  {#snippet pronouns()}
    {#if preferences.showPronouns && profile.pronouns.length > 0}
      <PronounPill pronouns={profile.pronouns} class="persona-profile-pronoun-pill" />
    {/if}
    {#if ownerProfile?.supporter_awards}
      <UserSupporterBadge
        userId={accountId}
        awards={ownerProfile.supporter_awards}
        name={displayName}
        isOwnBadge={core.session?.user_id === accountId}
        class="persona-profile-supporter-badge"
        {...profileSupporterAppearance(ownerProfile.extra)}
      />
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if onOpenAccount}
      <Pill onclick={onOpenAccount}>{$i18n.t('timeline.openAccount')}</Pill>
    {/if}
  {/snippet}
</ProfileCard>

<style>
  :global(.persona-profile-supporter-badge) {
    align-self: center;
    margin-inline: auto calc(-1 * var(--space-100));
    order: 1;
  }

  :global(.persona-profile-pronoun-pill) {
    --profile-text-muted: color-mix(in oklab, var(--sec-main) 55%, var(--bg-on-container));

    color: var(--profile-text-muted);
  }
</style>
