<script lang="ts">
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';
  import type { PerMessageProfileView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';

  import { senderColor } from '../timeline/timeline-format';

  interface Props {
    profile: PerMessageProfileView;
    accountId: string;
    accountName: string;
    variant?: 'popover' | 'sheet';
    onOpenAccount: () => void;
    onAvatarClick?: (source: string, displayName: string) => void;
  }

  let {
    profile,
    accountId,
    accountName,
    variant = 'popover',
    onOpenAccount,
    onAvatarClick,
  }: Props = $props();
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
  {/snippet}
  {#snippet actions()}
    <Button variant="secondary" size="small" onclick={onOpenAccount}>
      {$i18n.t('timeline.openAccount')}
    </Button>
  {/snippet}
</ProfileCard>

<style>
  :global(.persona-profile-pronoun-pill) {
    --profile-text-muted: color-mix(in oklab, var(--sec-main) 55%, var(--bg-on-container));

    color: var(--profile-text-muted);
  }
</style>
