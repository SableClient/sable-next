<script lang="ts">
  import type { MemberView, ProfileView, RoomPermissionsView } from '#src/generated/protocol';

  import type { MatrixLink } from './matrix-link.js';

  import { i18n } from '#lib/i18n.js';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';

  import MentionProfileCard from './MentionProfileCard.svelte';

  interface Props {
    open?: boolean;
    userId: string | null;
    member: MemberView | null;
    roomId: string;
    ownPowerLevel?: number;
    permissions?: RoomPermissionsView | null;
    profile?: ProfileView | null;
    onAvatarClick?: (source: string, displayName: string) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onPowerLevelChange?: (roomId: string, userId: string, level: number) => void;
    failed?: boolean;
    anchor: HTMLElement | null;
    onOpenChange?: (open: boolean) => void;
  }

  let {
    open = $bindable(false),
    userId,
    member,
    roomId,
    ownPowerLevel = 0,
    permissions = null,
    profile = null,
    onAvatarClick,
    onMatrixLink,
    onPowerLevelChange,
    failed = false,
    anchor,
    onOpenChange,
  }: Props = $props();

  function handleCloseAutoFocus(event: Event): void {
    event.preventDefault();
    anchor?.focus({ preventScroll: true });
  }
</script>

<ResponsivePopover
  bind:open
  {anchor}
  closeOnAnchorHidden
  label={$i18n.t('timeline.userProfile')}
  closeLabel={$i18n.t('timeline.closeProfile')}
  handleColor="var(--bg-container)"
  handleOpacity={1}
  contentInset={false}
  {onOpenChange}
  onCloseAutoFocus={handleCloseAutoFocus}
>
  {#snippet children(sheet)}
    {#if userId}
      <MentionProfileCard
        {userId}
        {member}
        {roomId}
        {ownPowerLevel}
        {permissions}
        {profile}
        {onAvatarClick}
        {onMatrixLink}
        {onPowerLevelChange}
        {failed}
        variant={sheet ? 'sheet' : 'popover'}
      />
    {/if}
  {/snippet}
</ResponsivePopover>
