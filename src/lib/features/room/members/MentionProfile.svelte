<script lang="ts">
  import type {
    MemberView,
    PerMessageProfileView,
    ProfileView,
    RoomPermissionsView,
  } from '#src/generated/protocol';

  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import type { PowerLevelTagMap } from '../settings/power-level-tags.js';

  import { i18n } from '#lib/i18n.js';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';

  import MentionProfileCard from './MentionProfileCard.svelte';
  import PersonaCard from './PersonaCard.svelte';

  interface Props {
    open?: boolean;
    userId: string | null;
    member: MemberView | null;
    roomId: string;
    ownPowerLevel?: number;
    permissions?: RoomPermissionsView | null;
    powerTags?: PowerLevelTagMap | null;
    profile?: ProfileView | null;
    pmp?: PerMessageProfileView | null;
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
    powerTags = null,
    profile = null,
    pmp = null,
    onAvatarClick,
    onMatrixLink,
    onPowerLevelChange,
    failed = false,
    anchor,
    onOpenChange,
  }: Props = $props();

  let side = $derived.by((): 'left' | 'right' => {
    if (!anchor) return 'right';
    const rect = anchor.getBoundingClientRect();
    return rect.left + rect.width / 2 > window.innerWidth / 2 ? 'left' : 'right';
  });

  function handleCloseAutoFocus(event: Event): void {
    event.preventDefault();
    anchor?.focus({ preventScroll: true });
  }
</script>

<ResponsivePopover
  bind:open
  {anchor}
  {side}
  sticky="always"
  collisionPadding={12}
  sideOffset={10}
  closeOnAnchorHidden
  label={$i18n.t('timeline.userProfile')}
  closeLabel={$i18n.t('timeline.closeProfile')}
  handleColor="var(--bg-container)"
  handleOpacity={1}
  contentInset={false}
  class="mention-profile-popover"
  {onOpenChange}
  onCloseAutoFocus={handleCloseAutoFocus}
>
  {#snippet children(sheet)}
    {#if pmp && userId}
      <PersonaCard
        accountId={userId}
        accountName={member?.display_name ?? ''}
        profile={pmp}
        onOpenAccount={() => {}}
        // TODO: Implement
        onAvatarClick={() => {}}
        // TODO: Implement
        variant={sheet ? 'sheet' : 'popover'}
      />
    {:else if userId}
      <MentionProfileCard
        {userId}
        {member}
        {roomId}
        {ownPowerLevel}
        {permissions}
        {powerTags}
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

<style>
  :global(.responsive-popover.mention-profile-popover) {
    width: min(21rem, calc(100vw - 2rem));
  }
</style>
