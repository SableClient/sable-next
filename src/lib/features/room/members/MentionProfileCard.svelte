<script lang="ts">
  import { serverNameOf } from '#lib/matrix-id.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { SUPPORTER_BADGE_FIELD } from '#lib/profile/fields.js';
  import type {
    MemberView,
    ProfileView,
    RoomPermissionsView,
    PerMessageProfileView,
    ProfileFieldView,
  } from '#src/generated/protocol';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import LockOpenIcon from 'phosphor-svelte/lib/LockOpenIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import GavelIcon from 'phosphor-svelte/lib/GavelIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import FlagIcon from 'phosphor-svelte/lib/FlagIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';
  import ShareNetworkIcon from 'phosphor-svelte/lib/ShareNetworkIcon';
  import LockKeyIcon from 'phosphor-svelte/lib/LockKeyIcon';

  import { onDestroy } from 'svelte';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { hasDirectRoom, roomPathParamFromId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { sendMessage } from '#lib/core/api/messages.svelte.js';
  import { openDirectMessage as openDm } from '#lib/core/api/rooms.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { mentionUri } from '#lib/model/model.js';
  import { matrixLinkHost } from '#lib/rooms/matrix-link.js';
  import type { PermalinkFormat } from '#lib/rooms/permalink.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { formatNowInZone } from '#lib/ui/date-time.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { lastSeenBucket, lastSeenMs, usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import { roleColorOnDark, roleColorOnLight } from '#lib/ui/primitives/readable-color.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
  import { meowlnirFor } from '#lib/rooms/meowlnir-registry.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import Pill from '#lib/ui/primitives/Pill.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';

  import MessageReportDialog from '../messages/MessageReportDialog.svelte';
  import MessageSourceDialog from '../messages/MessageSourceDialog.svelte';
  import MeowlnirBanDialog from './MeowlnirBanDialog.svelte';
  import ProfileOverrideDialog from './ProfileOverrideDialog.svelte';
  import { sendReport } from '../messages/report';
  import FormattedBody from '../messages/FormattedBody.svelte';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { powerTag } from './power-tags.js';
  import {
    FOUNDER_POWER_LEVEL,
    needsPowerConfirmation,
    type PowerLevelTagMap,
  } from '../settings/power-level-tags.js';
  import { senderColor } from '../timeline/timeline-format';

  import '#lib/ui/primitives/menu.css';
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import { MemberProfileRelations } from './member-profile-relations.svelte';
  import { MemberProfileActions, deletedMessagesNotice } from './member-profile-actions';
  import ModerationDialog from './ModerationDialog.svelte';
  import UserSecurityDialog from './UserSecurityDialog.svelte';
  import PersonaCard from './PersonaCard.svelte';
  import MentionProfileBadges from './MentionProfileBadges.svelte';
  import MentionProfileComposer from './MentionProfileComposer.svelte';
  import MentionProfileExtras from './MentionProfileExtras.svelte';
  import MentionProfileMeta from './MentionProfileMeta.svelte';
  import MentionProfileMutualRooms from './MentionProfileMutualRooms.svelte';
  import MentionProfilePowerMenu from './MentionProfilePowerMenu.svelte';
  import MentionProfilePresenceMenu from './MentionProfilePresenceMenu.svelte';
  import { MemberProfileSource } from './member-profile-source.svelte';

  interface Props {
    userId: string;
    member: MemberView | null;
    roomId: string;
    ownPowerLevel?: number;
    permissions?: RoomPermissionsView | null;
    powerTags?: PowerLevelTagMap | null;
    profile: ProfileView | null;
    pmp?: PerMessageProfileView | null;
    onOpenAccount?: () => void;
    onNestedMenuOpenChange?: (open: boolean) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onPowerLevelChange?: (roomId: string, userId: string, level: number) => void;
    failed?: boolean;
    variant?: 'popover' | 'sheet';
  }

  let {
    userId,
    member,
    roomId,
    ownPowerLevel = 0,
    permissions = null,
    powerTags = null,
    profile,
    pmp = null,
    onOpenAccount,
    onNestedMenuOpenChange,
    onMatrixLink,
    onPowerLevelChange,
    failed = false,
    variant = 'popover',
  }: Props = $props();
  const core = useCoreClient();
  const roomCosmetics = useRoomCosmetics();
  const roomList = useRoomList();
  const presenceStore = usePresenceStore();
  let invitedMember = $state.raw<MemberView | null>(null);
  let membershipRequest = 0;

  $effect(() => {
    const request = ++membershipRequest;
    const targetRoomId = roomId;
    const targetUserId = userId;
    invitedMember = null;
    if (member !== null || targetRoomId === '' || !(permissions?.can_kick ?? false)) return;

    void core.rpc.members
      .list({ room_id: targetRoomId, memberships: ['invite'] })
      .then((members) => {
        if (request !== membershipRequest) return;
        invitedMember = members.find((entry) => entry.user_id === targetUserId) ?? null;
      })
      .catch((error: unknown) => {
        console.debug('[sable profile] invited member unavailable', error);
      });
  });

  let roomMember = $derived(member ?? invitedMember);
  let currentProfile = $derived(profile?.user_id === userId ? profile : null);
  let presence = $derived(presenceStore.get(userId));
  let presenceLabel = $derived(presence ? i18n.t(`presence.${presence.presence}`) : null);
  let userStatus = $derived(resolveUserStatus(currentProfile, presence));
  let lastSeenText = $derived.by(() => {
    if (!presence || presence.presence !== 'offline') return null;
    const ms = lastSeenMs(presence, Date.now());
    if (ms === null) return null;

    const bucket = lastSeenBucket(ms);
    switch (bucket.kind) {
      case 'now':
        return i18n.t('presence.lastSeenNow');
      case 'minutes':
        return i18n.t('presence.lastSeenMinutes', { count: bucket.count });
      case 'hours':
        return i18n.t('presence.lastSeenHours', { count: bucket.count });
      case 'days':
        return i18n.t('presence.lastSeenDays', { count: bucket.count });
    }
  });

  let shown = $derived(roomMember ?? currentProfile);
  let realName = $derived(shown?.real_name ?? userId);
  let realAvatar = $derived(shown?.real_avatar_url ?? null);
  let displayName = $derived(shown?.display_name ?? userId);
  let avatarUrl = $derived(shown?.avatar_url ?? null);
  let overrideColors = $derived(profileOverrides.colors(userId));
  let overrideOpen = $state(false);
  let reportOpen = $state(false);
  let securityOpen = $state(false);
  let miscOpen = $state(false);
  let activeExtra = $state<ProfileFieldView | null>(null);
  let color = $derived(currentProfile?.hero_color ?? senderColor(userId));
  let cosmetics = $derived(roomCosmetics?.for(userId) ?? null);
  let pronouns = $derived(
    cosmetics?.pronouns.length ? cosmetics.pronouns : (currentProfile?.pronouns ?? [])
  );
  let localTime = $derived.by(() => {
    const timezone = currentProfile?.timezone;
    if (!timezone) return null;
    const time = formatNowInZone(timezone);
    return time === null ? null : { time, timezone };
  });
  let animalText = $derived.by(() => {
    const animal = currentProfile?.animal;
    if (!animal) return null;

    let identity: string;
    if (animal.is_animal && animal.has_animal) {
      identity = i18n.t('timeline.animalBoth', { is: animal.is_animal, has: animal.has_animal });
    } else if (animal.is_animal) {
      identity = i18n.t('timeline.animalIs', { is: animal.is_animal });
    } else if (animal.has_animal) {
      identity = i18n.t('timeline.animalHas', { has: animal.has_animal });
    } else {
      return null;
    }

    const need = animal.animal_need ?? 'headpats';
    if (!need) return `${identity}!`;

    return i18n.t('timeline.animalNeed', { identity, need });
  });
  let extra = $derived(
    (currentProfile?.extra ?? []).filter((field) => field.key !== SUPPORTER_BADGE_FIELD)
  );
  let showFailure = $derived(failed && !currentProfile && roomMember === null);
  let profileLoading = $derived(!currentProfile && !failed);
  let isSelf = $derived(core.session?.user_id === userId);
  let profileColors = $derived(isSelf || preferences.renderProfileColors ? currentProfile : null);
  let canMessage = $derived(core.session !== null && !isSelf);
  let draft = $state('');
  let sending = $state(false);
  let sendFailed = $state<'send' | 'open' | null>(null);
  let confirmingDirect = $state(false);

  function setConfirmingDirect(next: boolean): void {
    confirmingDirect = next;
    onNestedMenuOpenChange?.(next);
  }
  let homeserver = $derived(serverNameOf(userId));
  let elevated = $derived(roomMember !== null && roomMember.power_level >= 50);
  let roleTag = $derived(
    roomMember && powerTags !== null ? powerTag(roomMember.power_level, i18n.t, powerTags) : null
  );
  let outranks = $derived(!isSelf && ownPowerLevel > (roomMember?.power_level ?? 0));
  let canKick = $derived(
    outranks &&
      (roomMember?.membership === 'join' || roomMember?.membership === 'invite') &&
      (permissions?.can_kick ?? false)
  );
  let canBan = $derived(
    outranks && roomMember?.membership !== 'ban' && (permissions?.can_ban ?? false)
  );
  let canInvite = $derived(
    !isSelf &&
      (roomMember === null || roomMember.membership === 'leave') &&
      (permissions?.can_invite ?? false)
  );
  let canUnban = $derived(
    !isSelf && roomMember?.membership === 'ban' && (permissions?.can_ban ?? false)
  );
  let canSetPower = $derived(
    (permissions?.can_change_power_levels ?? false) &&
      (isSelf
        ? ownPowerLevel < FOUNDER_POWER_LEVEL
        : ownPowerLevel > (roomMember?.power_level ?? 0))
  );
  let powerConfirm = $state<number | null>(null);
  let profileLink = $derived(`https://${matrixLinkHost()}/#/${userId}`);
  const canShareLink = typeof navigator !== 'undefined' && 'share' in navigator;
  const relations = new MemberProfileRelations(core);
  const profileActions = new MemberProfileActions(core);
  const profileSource = new MemberProfileSource(core);
  let ignored = $derived(relations.ignored);
  let hasMeta = $derived(Boolean(localTime || animalText || roleTag || lastSeenText));

  $effect(() => {
    relations.sync(userId, isSelf);
  });

  onDestroy(() => relations.dispose());

  async function copyUserId(): Promise<void> {
    await profileActions.copy(userId);
  }

  function copyProfileLink(format: PermalinkFormat): void {
    const link = format === 'matrix' ? mentionUri(userId, []) : profileLink;
    if (link) void profileActions.copy(link);
  }

  async function copyServer(): Promise<void> {
    await profileActions.copy(homeserver);
  }

  async function shareProfileLink(): Promise<void> {
    await profileActions.share(profileLink, displayName);
  }

  function openServer(): void {
    profileActions.openServer(homeserver);
  }

  async function toggleIgnored(): Promise<void> {
    const next = !ignored;
    try {
      relations.ignored = await profileActions.setIgnored(userId, next);
    } catch (error) {
      console.warn('[sable profile] could not change ignore state', error);
    }
  }

  function moderate(action: (roomId: string, userId: string) => Promise<unknown>): () => void {
    return () => {
      void action(roomId, userId).catch((error: unknown) => {
        console.warn('[sable profile] moderation action failed', error);
      });
    };
  }

  let meowlnir = $derived(isSelf ? null : meowlnirFor(roomId, core.session?.user_id));
  let meowlnirBanOpen = $state(false);
  let moderationAction = $state<'kick' | 'ban' | null>(null);

  function openModeration(action: 'kick' | 'ban'): void {
    moderationAction = action;
  }

  async function confirmModeration(reason: string | null, redactEvents: boolean): Promise<void> {
    if (!moderationAction) return;
    const deleted = await profileActions.moderate(
      roomId,
      userId,
      moderationAction,
      reason,
      redactEvents
    );
    if (redactEvents) toasts.info(deletedMessagesNotice(displayName, deleted));
  }

  function setPowerLevel(level: number): void {
    if (needsPowerConfirmation(isSelf, level, ownPowerLevel) && powerConfirm === null) {
      powerConfirm = level;
      return;
    }
    powerConfirm = null;
    const target = roomId;
    const user = userId;
    void profileActions.setPowerLevel(target, user, level).then(
      () => onPowerLevelChange?.(target, user, level),
      (error: unknown) => {
        console.warn('[sable profile] power level change failed', error);
        toasts.error(i18n.t('errors.actionFailed'));
      }
    );
  }

  async function openDirectMessage(body: string): Promise<void> {
    if (sending) return;

    let step: 'send' | 'open' = 'open';
    sending = true;
    sendFailed = null;
    try {
      const dmId = await openDm(core, userId);
      if (body) {
        step = 'send';
        await sendMessage(core.rpc, dmId, body);
        draft = '';
        step = 'open';
      }
      await afterOverlayPops();
      await goto(resolve('/(app)/direct/[roomId]', { roomId: roomPathParamFromId(dmId) }));
    } catch (error) {
      console.warn('[sable profile] could not open a chat', error);
      sendFailed = step;
    } finally {
      sending = false;
    }
  }

  function messageUser(): void {
    if (hasDirectRoom(roomList.rooms, userId)) void openDirectMessage('');
    else setConfirmingDirect(true);
  }

  function sendDirectMessage(event: SubmitEvent): void {
    event.preventDefault();
    void openDirectMessage(draft.trim());
  }
</script>

{#snippet pronounRow()}
  <MentionProfileBadges {userId} {displayName} {pronouns} profile={currentProfile} {isSelf} />
{/snippet}
{#snippet metaRow()}
  <MentionProfileMeta
    loading={profileLoading}
    {lastSeenText}
    {localTime}
    {roleTag}
    {elevated}
    {animalText}
  />
{/snippet}

{#snippet actionRow()}
  {#if pmp && onOpenAccount}
    <Pill onclick={onOpenAccount}>{i18n.t('timeline.openAccount')}</Pill>
  {:else}
    <ActionMenu label={i18n.t('common.share')} align="start" onOpenChange={onNestedMenuOpenChange}>
      {#snippet trigger({ props })}
        <Pill {...props}>
          <ShareNetworkIcon size={14} />
          {i18n.t('common.share')}
        </Pill>
      {/snippet}
      <IconContext values={{ 'aria-hidden': 'true' }}>
        <ActionMenuItem onSelect={copyUserId}>
          {i18n.t('timeline.profileCopyId')}
        </ActionMenuItem>
        <ActionMenuItem onSelect={() => copyProfileLink('matrix')}>
          <LinkIcon />
          {i18n.t('timeline.copyMatrixLink')}
        </ActionMenuItem>
        <ActionMenuItem onSelect={() => copyProfileLink('external')}>
          <LinkIcon />
          {i18n.t('timeline.copyExternalLink')}
        </ActionMenuItem>
      </IconContext>
    </ActionMenu>
  {/if}
  {#if !isSelf}
    <MentionProfileMutualRooms rooms={relations.rooms} onOpenChange={onNestedMenuOpenChange} />
  {/if}
  <ActionMenu label={i18n.t('timeline.moreActions')} onOpenChange={onNestedMenuOpenChange}>
    {#snippet trigger({ props })}
      <Pill {...props} iconOnly aria-label={i18n.t('timeline.moreActions')}>
        <DotsThreeIcon size={14} />
      </Pill>
    {/snippet}
    <IconContext values={{ 'aria-hidden': 'true' }}>
      <ActionMenuItem onSelect={copyServer}>
        <CopyIcon />
        {i18n.t('timeline.profileCopyServer')}
      </ActionMenuItem>
      <ActionMenuItem onSelect={openServer}>
        <ArrowSquareOutIcon />
        {i18n.t('timeline.profileOpenServer')}
      </ActionMenuItem>
      {#if canShareLink}
        <ActionMenuItem onSelect={shareProfileLink}>
          <ShareNetworkIcon />
          {i18n.t('timeline.profileShareLink')}
        </ActionMenuItem>
      {/if}
      <ActionMenuItem onSelect={() => profileSource.viewProfile(userId)}>
        <CodeIcon />
        {i18n.t('common.viewSource')}
      </ActionMenuItem>
      {#if roomId !== ''}
        <ActionMenuItem onSelect={() => profileSource.viewMemberEvent(roomId, userId)}>
          <CodeIcon />
          {i18n.t('timeline.profileMemberEvent')}
        </ActionMenuItem>
      {/if}
      {#if !isSelf}
        <ActionMenuSeparator />
        <ActionMenuItem onSelect={() => (securityOpen = true)}>
          <LockKeyIcon />
          {i18n.t('timeline.profileEncryption')}
        </ActionMenuItem>
      {/if}
      {#if canInvite}
        <ActionMenuItem
          onSelect={moderate((room_id, user_id) => core.rpc.rooms.invite({ room_id, user_id }))}
        >
          <UserPlusIcon />
          {i18n.t('timeline.profileInvite')}
        </ActionMenuItem>
      {/if}
      {#if canUnban}
        <ActionMenuItem
          onSelect={moderate((room_id, user_id) =>
            core.rpc.members.unban({ room_id, user_id, reason: null })
          )}
        >
          <LockOpenIcon />
          {i18n.t('timeline.profileUnban')}
        </ActionMenuItem>
      {/if}
      {#if canSetPower}
        <MentionProfilePowerMenu
          {ownPowerLevel}
          currentLevel={roomMember?.power_level ?? 0}
          {powerTags}
          onSelect={setPowerLevel}
        />
      {/if}
      {#if canKick}
        <ActionMenuItem
          destructive
          onSelect={() => {
            openModeration('kick');
          }}
        >
          <SignOutIcon />
          {i18n.t('timeline.profileKick')}
        </ActionMenuItem>
      {/if}
      {#if canBan}
        <ActionMenuItem
          destructive
          onSelect={() => {
            openModeration('ban');
          }}
        >
          <GavelIcon />
          {i18n.t('timeline.profileBan')}
        </ActionMenuItem>
      {/if}
      {#if meowlnir}
        <ActionMenuItem destructive onSelect={() => (meowlnirBanOpen = true)}>
          <GavelIcon />
          {i18n.t('timeline.meowlnirBan')}
        </ActionMenuItem>
      {/if}
      {#if !isSelf}
        {#if canKick || canBan || meowlnir}
          <ActionMenuSeparator />
        {/if}
        <ActionMenuItem onSelect={() => (overrideOpen = true)}>
          <PencilSimpleIcon />
          {i18n.t('timeline.profileOverride')}
        </ActionMenuItem>
        <MentionProfilePresenceMenu {userId} />
        <ActionMenuSeparator />
        <ActionMenuItem destructive onSelect={toggleIgnored}>
          <ProhibitIcon />
          {ignored ? i18n.t('timeline.profileUnblock') : i18n.t('timeline.profileBlock')}
        </ActionMenuItem>
        <ActionMenuItem destructive onSelect={() => (reportOpen = true)}>
          <FlagIcon />
          {i18n.t('timeline.profileReport')}
        </ActionMenuItem>
      {/if}
    </IconContext>
  </ActionMenu>
{/snippet}

{#snippet messageAction()}
  <Pill variant="primary" onclick={messageUser}>
    <ChatCircleIcon size={14} weight="fill" />
    {i18n.t('timeline.profileMessage')}
  </Pill>
{/snippet}

{#snippet profileBelow()}
  <div class="profile-card-actions">{@render actionRow()}</div>
{/snippet}

{#snippet bioPanel()}
  {#if showFailure}
    <Alert variant="warning" role="status">{i18n.t('timeline.profileUnavailable')}</Alert>
  {:else if currentProfile?.bio}
    <FormattedBody
      html={currentProfile.bio}
      senderTimezone={currentProfile.timezone}
      keepMentionText
      {onMatrixLink}
    />
  {/if}
{/snippet}

{#snippet composer()}
  <MentionProfileComposer
    bind:draft
    name={displayName}
    {sending}
    {sendFailed}
    onSubmit={sendDirectMessage}
  />
{/snippet}

{#snippet miscData()}
  <MentionProfileExtras {extra} bind:open={miscOpen} bind:active={activeExtra} />
{/snippet}

{#if pmp}
  <PersonaCard
    profile={pmp}
    accountId={userId}
    accountName={realName}
    accountProfile={currentProfile}
    member={roomMember}
    {powerTags}
    {onMatrixLink}
    {variant}
    below={profileBelow}
    headerAction={variant === 'popover' && canMessage ? messageAction : undefined}
    composer={variant === 'sheet' && canMessage ? composer : undefined}
  />
{:else}
  <ProfileCard
    {displayName}
    {userId}
    {avatarUrl}
    {color}
    heroColor={currentProfile?.hero_color}
    heroBrightness={currentProfile?.hero_brightness}
    bannerUrl={currentProfile?.banner_url}
    status={userStatus?.text}
    statusEmoji={userStatus?.emoji}
    presence={presence?.presence}
    presenceLabel={presenceLabel ?? ''}
    nameColorLight={overrideColors === null
      ? null
      : (overrideColors?.light ??
        cosmetics?.colorOnLight ??
        profileColors?.name_color_light ??
        roleColorOnLight(roleTag?.color))}
    nameColorDark={overrideColors === null
      ? null
      : (overrideColors?.dark ??
        cosmetics?.colorOnDark ??
        profileColors?.name_color_dark ??
        roleColorOnDark(roleTag?.color))}
    meta={profileLoading || hasMeta ? metaRow : undefined}
    below={profileBelow}
    pronouns={pronounRow}
    children={showFailure || currentProfile?.bio ? bioPanel : undefined}
    footer={extra.length > 0 ? miscData : undefined}
    headerAction={variant === 'popover' && canMessage ? messageAction : undefined}
    composer={variant === 'sheet' && canMessage ? composer : undefined}
    insetBody
    {variant}
  />
{/if}

<MessageReportDialog
  bind:open={reportOpen}
  title={i18n.t('timeline.profileReportTitle', { name: displayName })}
  hint={i18n.t('timeline.profileReportHint')}
  onReport={(reason) => {
    const target = userId;
    void sendReport(async () => {
      await core.rpc.account.reportUser({ user_id: target, reason: reason ?? '' });
    });
  }}
/>

<ProfileOverrideDialog
  open={overrideOpen}
  {userId}
  {realName}
  {realAvatar}
  onOpenChange={(next) => (overrideOpen = next)}
/>

<MessageSourceDialog
  bind:open={profileSource.open}
  title={profileSource.title}
  source={profileSource.text}
/>

<UserSecurityDialog
  open={securityOpen}
  {userId}
  {displayName}
  onOpenChange={(next) => (securityOpen = next)}
/>

<ConfirmDialog
  open={confirmingDirect}
  onOpenChange={setConfirmingDirect}
  title={i18n.t('direct.confirmTitle', { name: displayName })}
  description={i18n.t('direct.confirmBody')}
  confirmLabel={i18n.t('direct.submit')}
  confirmVariant="primary"
  onConfirm={() => {
    setConfirmingDirect(false);
    void openDirectMessage('');
  }}
/>

<ConfirmDialog
  open={powerConfirm !== null}
  title={isSelf
    ? i18n.t('timeline.profileDemoteSelfTitle')
    : i18n.t('timeline.profilePromoteEqualTitle', { name: displayName })}
  description={isSelf
    ? i18n.t('timeline.profileDemoteSelfBody')
    : i18n.t('timeline.profilePromoteEqualBody', { name: displayName, user: userId })}
  confirmLabel={isSelf
    ? i18n.t('timeline.profileDemoteSelfConfirm')
    : i18n.t('timeline.profilePromoteEqualConfirm')}
  onOpenChange={(next: boolean) => {
    if (!next) powerConfirm = null;
  }}
  onCancel={() => {
    powerConfirm = null;
  }}
  onConfirm={() => {
    if (powerConfirm !== null) setPowerLevel(powerConfirm);
  }}
/>

{#if meowlnir}
  <MeowlnirBanDialog
    bind:open={meowlnirBanOpen}
    management={meowlnir}
    {userId}
    name={displayName}
  />
{/if}

<ModerationDialog
  action={moderationAction}
  name={displayName}
  onConfirm={confirmModeration}
  onClose={() => (moderationAction = null)}
/>

<style>
  :global(.profile-card-actions) {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
    justify-content: flex-start;
    width: 100%;
  }

  :global(.profile-card-actions > .pill-icon-only) {
    margin-inline-start: auto;
  }
</style>
