<script lang="ts">
  import type { Snippet } from 'svelte';
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';
  import type { MemberView, PerMessageProfileView, ProfileView } from '#src/generated/protocol';
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import ShieldIcon from 'phosphor-svelte/lib/ShieldIcon';
  import { useCoreClient } from '#lib/core/context.js';
  import UserSupporterBadge from '#lib/supporter/UserSupporterBadge.svelte';
  import { profileSupporterAppearance } from '#lib/supporter/variants.js';

  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';

  import { senderColor } from '../timeline/timeline-format';
  import type { PowerLevelTagMap } from '../settings/power-level-tags.js';
  import { powerTag } from './power-tags.js';
  import RoleTagIcon from './RoleTagIcon.svelte';

  interface Props {
    profile: PerMessageProfileView;
    accountId: string;
    accountName: string;
    accountProfile?: ProfileView | null;
    member?: MemberView | null;
    powerTags?: PowerLevelTagMap | null;
    below?: Snippet;
    headerAction?: Snippet;
    composer?: Snippet;
    variant?: 'popover' | 'sheet';
    onAvatarClick?: (source: string, displayName: string) => void;
  }

  let {
    profile,
    accountId,
    accountName,
    accountProfile = null,
    member = null,
    powerTags = null,
    below,
    headerAction,
    composer,
    variant = 'popover',
    onAvatarClick,
  }: Props = $props();
  const core = useCoreClient();
  let ownerProfile = $derived(accountProfile?.user_id === accountId ? accountProfile : null);
  let ownerMember = $derived(member?.user_id === accountId ? member : null);
  let roleTag = $derived(
    ownerMember && powerTags !== null ? powerTag(ownerMember.power_level, $i18n.t, powerTags) : null
  );
  let elevated = $derived(ownerMember !== null && ownerMember.power_level >= 50);
  let localTime = $derived.by(() => {
    const timezone = ownerProfile?.timezone;
    if (!timezone) return null;

    try {
      const time = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
      }).format(new Date());
      return { time, timezone };
    } catch {
      return null;
    }
  });
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
  meta={localTime || roleTag ? metaRow : undefined}
  {below}
  {headerAction}
  {composer}
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
</ProfileCard>

{#snippet metaRow()}
  {#if localTime}
    <span class="profile-meta-item">
      <ClockIcon />
      {localTime.time}
      <span class="profile-meta-aside">({localTime.timezone})</span>
    </span>
  {/if}
  {#if roleTag}
    <span class="profile-meta-item" class:profile-meta-elevated={elevated}>
      <ShieldIcon />
      {#if roleTag.icon}<RoleTagIcon icon={roleTag.icon} class="profile-role-icon" />{/if}
      {roleTag.name}
    </span>
  {/if}
{/snippet}

<style>
  .profile-meta-item {
    align-items: center;
    display: inline-flex;
    gap: var(--space-100);
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .profile-meta-elevated {
    color: var(--profile-ink, var(--bg-on-container));
    font-weight: var(--font-weight-medium);
  }

  .profile-meta-elevated :global(svg) {
    color: var(--profile-ink, var(--bg-on-container));
  }

  .profile-meta-aside {
    color: var(--profile-text-muted, var(--surface-var-on-container));
  }

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
