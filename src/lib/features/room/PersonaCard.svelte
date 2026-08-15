<script lang="ts">
  import type { PerMessageProfileView } from '@/generated/PerMessageProfileView';

  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import ProfileCard from '$lib/ui/primitives/ProfileCard.svelte';

  import { senderColor } from './timeline-format';

  interface Props {
    profile: PerMessageProfileView;
    accountId: string;
    accountName: string;
    variant?: 'popover' | 'sheet';
    onOpenAccount: () => void;
  }

  let { profile, accountId, accountName, variant = 'popover', onOpenAccount }: Props = $props();
  let displayName = $derived(profile.display_name ?? accountName);
  let pronouns = $derived(profile.pronouns.map((pronoun) => pronoun.summary).join(' · '));
</script>

<ProfileCard
  {displayName}
  {variant}
  userId={accountId}
  avatarUrl={profile.avatar_url}
  color={senderColor(profile.id ?? displayName)}
  nameColorLight={profile.color_on_light}
  nameColorDark={profile.color_on_dark}
>
  {#snippet meta()}
    {#if pronouns}
      <span class="pronouns">{pronouns}</span>
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="secondary" size="small" onclick={onOpenAccount}>
      {$i18n.t('timeline.openAccount')}
    </Button>
  {/snippet}
</ProfileCard>

<style>
  .pronouns {
    text-transform: lowercase;
  }
</style>
