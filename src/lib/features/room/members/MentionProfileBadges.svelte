<script lang="ts">
  import type { PronounView, ProfileView } from '#src/generated/protocol';

  import UserSupporterBadge from '#lib/supporter/UserSupporterBadge.svelte';
  import { profileSupporterAppearance } from '#lib/supporter/variants.js';
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';

  interface Props {
    userId: string;
    displayName: string;
    pronouns: readonly PronounView[];
    profile: ProfileView | null;
    isSelf: boolean;
  }

  let { userId, displayName, pronouns, profile, isSelf }: Props = $props();
</script>

{#if pronouns.length > 0}
  <PronounPill class="profile-pronoun-pill" {pronouns} showAll />
{/if}
{#if profile?.supporter_awards}
  <UserSupporterBadge
    {userId}
    awards={profile.supporter_awards}
    name={displayName}
    isOwnBadge={isSelf}
    class="profile-supporter-badge"
    {...profileSupporterAppearance(profile.extra)}
  />
{/if}

<style>
  :global(.profile-supporter-badge) {
    align-self: center;
    margin-inline: auto calc(-1 * var(--space-100));
    order: 1;
  }

  :global(.profile-pronoun-pill) {
    --pronoun-pill-ground: var(--profile-pronoun-ground, var(--profile-panel-ground));

    color: var(--profile-text-muted);
  }
</style>
