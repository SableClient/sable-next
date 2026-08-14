<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';
  import type { ProfileView } from '@/generated/ProfileView';

  import ProfileCard from '$lib/ui/primitives/ProfileCard.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import type { MatrixLink } from './matrix-link';
  import { senderColor } from './timeline-format';

  interface Props {
    userId: string;
    member: MemberView | null;
    profile: ProfileView | null;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { userId, member, profile, onMatrixLink }: Props = $props();
  let currentProfile = $derived(profile?.user_id === userId ? profile : null);
  let displayName = $derived(currentProfile?.display_name ?? member?.display_name ?? userId);
  let avatarUrl = $derived(currentProfile?.avatar_url ?? member?.avatar_url ?? null);
  let color = $derived(currentProfile?.hero_color ?? senderColor(userId));
</script>

<ProfileCard {displayName} {userId} {avatarUrl} {color}>
  {#if currentProfile?.bio}
    <FormattedBody body={currentProfile.bio} formatted={currentProfile.bio} {onMatrixLink} />
  {/if}
</ProfileCard>
