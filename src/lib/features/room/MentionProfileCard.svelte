<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import type { ProfileView } from '#src/generated/ProfileView';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import { DropdownMenu } from 'bits-ui';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import LockOpenIcon from 'phosphor-svelte/lib/LockOpenIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import GavelIcon from 'phosphor-svelte/lib/GavelIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import PaperPlaneRightIcon from 'phosphor-svelte/lib/PaperPlaneRightIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';
  import ShareNetworkIcon from 'phosphor-svelte/lib/ShareNetworkIcon';
  import ShieldIcon from 'phosphor-svelte/lib/ShieldIcon';
  import UsersThreeIcon from 'phosphor-svelte/lib/UsersThreeIcon';
  import UserIcon from 'phosphor-svelte/lib/UserIcon';

  import { goto } from '$app/navigation';
  import type { MutualRoomView } from '#src/generated/MutualRoomView';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { preferredPronouns } from '#lib/personas/pronouns.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { lastSeenBucket, lastSeenMs, usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import MutualRoomsPanel from './MutualRoomsPanel.svelte';
  import { senderColor } from './timeline-format';

  interface Props {
    userId: string;
    member: MemberView | null;
    roomId: string;
    ownPowerLevel?: number;
    permissions?: RoomPermissionsView | null;
    profile: ProfileView | null;
    failed?: boolean;
    variant?: 'popover' | 'sheet';
  }

  let {
    userId,
    member,
    roomId,
    ownPowerLevel = 0,
    permissions = null,
    profile,
    failed = false,
    variant = 'popover',
  }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const presenceStore = usePresenceStore();
  let currentProfile = $derived(profile?.user_id === userId ? profile : null);
  let presence = $derived(presenceStore.get(userId));
  let presenceLabel = $derived(presence ? $i18n.t(`presence.${presence.presence}`) : null);
  let lastSeenText = $derived.by(() => {
    if (!presence || presence.presence !== 'offline') return null;
    const ms = lastSeenMs(presence, Date.now());
    if (ms === null) return null;

    const bucket = lastSeenBucket(ms);
    switch (bucket.kind) {
      case 'now':
        return $i18n.t('presence.lastSeenNow');
      case 'minutes':
        return $i18n.t('presence.lastSeenMinutes', { count: bucket.count });
      case 'hours':
        return $i18n.t('presence.lastSeenHours', { count: bucket.count });
      case 'days':
        return $i18n.t('presence.lastSeenDays', { count: bucket.count });
    }
  });

  let displayName = $derived(member?.display_name ?? currentProfile?.display_name ?? userId);
  let avatarUrl = $derived(member?.avatar_url ?? currentProfile?.avatar_url ?? null);
  let color = $derived(currentProfile?.hero_color ?? senderColor(userId));
  let pronouns = $derived(
    (preferences.filterPronounsByLanguage
      ? preferredPronouns(currentProfile?.pronouns ?? [], $i18n.resolvedLanguage ?? $i18n.language)
      : (currentProfile?.pronouns ?? [])
    )
      .map((pronoun) => pronoun.summary)
      .join(', ')
  );
  let localTime = $derived.by(() => {
    const timezone = currentProfile?.timezone;
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
  let animalText = $derived.by(() => {
    const animal = currentProfile?.animal;
    if (!animal) return null;

    let identity: string;
    if (animal.is_animal && animal.has_animal) {
      identity = $i18n.t('timeline.animalBoth', { is: animal.is_animal, has: animal.has_animal });
    } else if (animal.is_animal) {
      identity = $i18n.t('timeline.animalIs', { is: animal.is_animal });
    } else if (animal.has_animal) {
      identity = $i18n.t('timeline.animalHas', { has: animal.has_animal });
    } else {
      return null;
    }

    return $i18n.t('timeline.animalNeed', {
      identity,
      need: animal.animal_need ?? $i18n.t('timeline.animalDefaultNeed'),
    });
  });
  let extra = $derived(currentProfile?.extra ?? []);
  let showFailure = $derived(failed && !currentProfile && member === null);
  let profileLoading = $derived(!currentProfile && !failed);
  let isSelf = $derived(core.session?.user_id === userId);
  let canMessage = $derived(core.session !== null && !isSelf);
  let messageLabel = $derived($i18n.t('timeline.messageUser', { name: displayName }));
  let draft = $state('');
  let sending = $state(false);
  let sendFailed = $state(false);
  let homeserver = $derived(userId.slice(userId.indexOf(':') + 1));
  let roleLabel = $derived.by(() => {
    if (!member) return null;
    if (member.power_level >= 100) return $i18n.t('timeline.powerLevelAdmin');
    if (member.power_level >= 50) return $i18n.t('timeline.powerLevelModerator');
    return $i18n.t('timeline.powerLevelMember');
  });
  let elevated = $derived(member !== null && member.power_level >= 50);
  let outranks = $derived(!isSelf && ownPowerLevel > (member?.power_level ?? 0));
  let canKick = $derived(outranks && (permissions?.can_kick ?? false));
  let canBan = $derived(outranks && (permissions?.can_ban ?? false));
  let canInvite = $derived(!isSelf && member === null && (permissions?.can_invite ?? false));
  let canUnban = $derived(!isSelf && member === null && (permissions?.can_ban ?? false));
  let canSetPower = $derived(
    !isSelf &&
      (permissions?.can_change_power_levels ?? false) &&
      ownPowerLevel > (member?.power_level ?? 0)
  );
  // The spec caps what you may grant at your own level.
  let powerRoles = $derived(
    [
      { level: 100, label: $i18n.t('timeline.powerLevelAdmin') },
      { level: 50, label: $i18n.t('timeline.powerLevelModerator') },
      { level: 0, label: $i18n.t('timeline.powerLevelMember') },
      { level: -1, label: $i18n.t('timeline.powerLevelMuted') },
    ].filter((role) => role.level <= ownPowerLevel && role.level !== (member?.power_level ?? 0))
  );
  let profileLink = $derived(`https://matrix.to/#/${userId}`);
  const canShareLink = typeof navigator !== 'undefined' && 'share' in navigator;
  let mutualRooms = $state.raw<MutualRoomView[]>([]);
  let ignored = $state(false);
  let shared = $state<'rooms' | 'spaces' | null>(null);
  let miscOpen = $state(false);
  let sharedRooms = $derived(mutualRooms.filter((room) => !room.is_space));
  let sharedSpaces = $derived(mutualRooms.filter((room) => room.is_space));
  let sharedList = $derived(shared === 'spaces' ? sharedSpaces : sharedRooms);
  let sharedExpanded = $state(false);
  let hasMeta = $derived(
    Boolean(pronouns || localTime || animalText || roleLabel || presenceLabel)
  );

  $effect(() => {
    const target = userId;
    // The card instance is reused for the next user, so the previous answer
    // must not survive until this one lands.
    mutualRooms = [];
    ignored = false;
    if (isSelf) return;

    let cancelled = false;
    void core.userRelations(target).then(
      (relations) => {
        if (cancelled) return;
        mutualRooms = relations.mutualRooms;
        ignored = relations.ignored;
      },
      (error: unknown) => {
        console.warn('[sable profile] user relations unavailable', error);
      }
    );
    return () => {
      cancelled = true;
      shared = null;
    };
  });

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.debug('[sable profile] clipboard unavailable', error);
    }
  }

  async function copyUserId(): Promise<void> {
    await copy(userId);
  }

  async function copyProfileLink(): Promise<void> {
    await copy(profileLink);
  }

  async function copyServer(): Promise<void> {
    await copy(homeserver);
  }

  async function shareProfileLink(): Promise<void> {
    try {
      await navigator.share({ url: profileLink, title: displayName });
    } catch (error) {
      console.debug('[sable profile] share dismissed', error);
    }
  }

  function openServer(): void {
    window.open(`https://${homeserver}`, '_blank', 'noopener,noreferrer');
  }

  async function toggleIgnored(): Promise<void> {
    const next = !ignored;
    try {
      await core.setUserIgnored(userId, next);
      ignored = next;
    } catch (error) {
      console.warn('[sable profile] could not change ignore state', error);
    }
  }

  function moderate(action: (roomId: string, userId: string) => Promise<void>): () => void {
    return () => {
      void action.call(core, roomId, userId).catch((error: unknown) => {
        console.warn('[sable profile] moderation action failed', error);
      });
    };
  }

  let moderationAction = $state<'kick' | 'ban' | null>(null);
  let moderationReason = $state('');
  let moderationBusy = $state(false);
  let moderationFailed = $state(false);
  const moderationFieldId = $props.id();

  function openModeration(action: 'kick' | 'ban'): void {
    moderationAction = action;
    moderationReason = '';
    moderationFailed = false;
  }

  function cancelModeration(): void {
    moderationAction = null;
    moderationReason = '';
  }

  async function confirmModeration(): Promise<void> {
    const action = moderationAction;
    if (!action || moderationBusy) return;

    const reason = moderationReason.trim();
    moderationBusy = true;
    moderationFailed = false;
    try {
      if (action === 'kick') await core.commands.kickUser(roomId, userId, reason || null);
      else await core.commands.banUser(roomId, userId, reason || null);
      moderationAction = null;
      moderationReason = '';
    } catch (error) {
      console.warn('[sable profile] moderation action failed', error);
      moderationFailed = true;
    } finally {
      moderationBusy = false;
    }
  }

  function setPowerLevel(level: number): void {
    void core.commands.setUserPowerLevel(roomId, userId, level).catch((error: unknown) => {
      console.warn('[sable profile] power level change failed', error);
    });
  }

  function showShared(kind: 'rooms' | 'spaces' | null): void {
    shared = shared === kind ? null : kind;
    sharedExpanded = false;
  }

  function openRoom(target: string): void {
    void goto(roomSectionPath(roomList.rooms, target));
  }

  async function sendDirectMessage(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    sending = true;
    sendFailed = false;
    try {
      const roomId = await core.commands.createDm(userId);
      await core.commands.sendMessage(roomId, body);
      draft = '';
    } catch {
      sendFailed = true;
    } finally {
      sending = false;
    }
  }
</script>

{#snippet metaRow()}
  {#if presenceLabel}
    <span class="profile-meta-item">
      <PresenceDot presence={presence?.presence ?? 'offline'} label={presenceLabel} />
      {presence?.statusMessage || lastSeenText || presenceLabel}
    </span>
  {/if}
  {#if pronouns}
    <span class="profile-meta-item"><UserIcon />{pronouns}</span>
  {/if}
  {#if localTime}
    <span class="profile-meta-item">
      <ClockIcon />
      {localTime.time}
      <span class="profile-meta-aside">({localTime.timezone})</span>
    </span>
  {/if}
  {#if animalText}
    <span class="profile-meta-item"><HeartIcon />{animalText}</span>
  {/if}
  {#if roleLabel}
    <span class="profile-meta-item" class:profile-meta-elevated={elevated}>
      <ShieldIcon />
      {roleLabel}
    </span>
  {/if}
{/snippet}

{#snippet actionRow()}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="profile-action sable-open">
      <ShareNetworkIcon size={14} />
      {$i18n.t('timeline.profileShare')}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="sable-menu" side="bottom" align="start" sideOffset={4}>
      <IconContext values={{ 'aria-hidden': 'true' }}>
        <DropdownMenu.Item class="sable-menu-item" onSelect={copyUserId}>
          {$i18n.t('timeline.profileCopyId')}
        </DropdownMenu.Item>
        <DropdownMenu.Item class="sable-menu-item" onSelect={copyProfileLink}>
          {$i18n.t('timeline.profileCopyLink')}
        </DropdownMenu.Item>
        {#if canShareLink}
          <DropdownMenu.Item class="sable-menu-item" onSelect={shareProfileLink}>
            {$i18n.t('timeline.profileShareLink')}
          </DropdownMenu.Item>
        {/if}
      </IconContext>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
  {#if sharedRooms.length > 0}
    <button
      class="profile-action sable-open"
      type="button"
      aria-expanded={shared === 'rooms'}
      onclick={() => {
        showShared('rooms');
      }}
    >
      <ChatsIcon size={14} />
      {$i18n.t('timeline.profileMutualRooms', { count: sharedRooms.length })}
    </button>
  {/if}
  {#if sharedSpaces.length > 0}
    <button
      class="profile-action sable-open"
      type="button"
      aria-expanded={shared === 'spaces'}
      onclick={() => {
        showShared('spaces');
      }}
    >
      <UsersThreeIcon size={14} />
      {$i18n.t('timeline.profileMutualSpaces', { count: sharedSpaces.length })}
    </button>
  {/if}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="profile-action profile-action-overflow sable-open"
      aria-label={$i18n.t('timeline.profileMoreActions')}
    >
      <DotsThreeIcon size={14} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="sable-menu" side="bottom" align="end" sideOffset={4}>
      <IconContext values={{ 'aria-hidden': 'true' }}>
        <DropdownMenu.Item class="sable-menu-item" onSelect={copyServer}>
          <CopyIcon />
          {$i18n.t('timeline.profileCopyServer')}
        </DropdownMenu.Item>
        <DropdownMenu.Item class="sable-menu-item" onSelect={openServer}>
          <ArrowSquareOutIcon />
          {$i18n.t('timeline.profileOpenServer')}
        </DropdownMenu.Item>
        {#if canInvite}
          <DropdownMenu.Item class="sable-menu-item" onSelect={moderate(core.commands.inviteUser)}>
            <UserPlusIcon />
            {$i18n.t('timeline.profileInvite')}
          </DropdownMenu.Item>
        {/if}
        {#if canUnban}
          <DropdownMenu.Item class="sable-menu-item" onSelect={moderate(core.commands.unbanUser)}>
            <LockOpenIcon />
            {$i18n.t('timeline.profileUnban')}
          </DropdownMenu.Item>
        {/if}
        {#if canSetPower}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger class="sable-menu-item">
              <ShieldIcon />
              {$i18n.t('timeline.profileChangePower')}
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent class="sable-menu" sideOffset={4}>
              <IconContext values={{ 'aria-hidden': 'true' }}>
                {#each powerRoles as role (role.level)}
                  <DropdownMenu.Item
                    class="sable-menu-item"
                    onSelect={() => {
                      setPowerLevel(role.level);
                    }}
                  >
                    <span class="profile-power-name">{role.label}</span>
                    <span class="profile-power-level">{role.level}</span>
                  </DropdownMenu.Item>
                {/each}
              </IconContext>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        {/if}
        {#if canKick}
          <DropdownMenu.Item
            class="sable-menu-item sable-menu-item-destructive profile-menu-destructive"
            onSelect={() => {
              openModeration('kick');
            }}
          >
            <SignOutIcon />
            {$i18n.t('timeline.profileKick')}
          </DropdownMenu.Item>
        {/if}
        {#if canBan}
          <DropdownMenu.Item
            class={[
              'sable-menu-item sable-menu-item-destructive profile-menu-destructive',
              canKick && 'profile-menu-grouped',
            ]}
            onSelect={() => {
              openModeration('ban');
            }}
          >
            <GavelIcon />
            {$i18n.t('timeline.profileBan')}
          </DropdownMenu.Item>
        {/if}
        {#if !isSelf}
          <DropdownMenu.Item
            class={[
              'sable-menu-item sable-menu-item-destructive profile-menu-destructive',
              (canKick || canBan) && 'profile-menu-grouped',
            ]}
            onSelect={toggleIgnored}
          >
            <ProhibitIcon />
            {ignored ? $i18n.t('timeline.profileUnblock') : $i18n.t('timeline.profileBlock')}
          </DropdownMenu.Item>
        {/if}
      </IconContext>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet metaPlaceholder()}
  <span class="profile-meta-item"
    ><Skeleton style="height: var(--font-size-small); width: 5rem" /></span
  >
  <span class="profile-meta-item"
    ><Skeleton style="height: var(--font-size-small); width: 7rem" /></span
  >
{/snippet}

{#snippet bioPanel()}
  {#if showFailure}
    <Alert variant="warning" role="status">{$i18n.t('timeline.profileUnavailable')}</Alert>
  {:else if currentProfile?.bio}
    <FormattedBody html={currentProfile.bio} />
  {/if}
{/snippet}

{#snippet sharedPanel()}
  <MutualRoomsPanel
    kind={shared === 'spaces' ? 'spaces' : 'rooms'}
    rooms={sharedList}
    expanded={sharedExpanded}
    onOpenRoom={openRoom}
    onExpand={() => {
      sharedExpanded = true;
    }}
    onBack={() => {
      showShared(null);
    }}
  />
{/snippet}

{#snippet composer()}
  <form class="profile-composer" onsubmit={sendDirectMessage}>
    <TextInput
      bind:value={draft}
      class="profile-composer-input"
      placeholder={messageLabel}
      aria-label={messageLabel}
      disabled={sending}
    />
    <IconButton
      label={$i18n.t('timeline.sendMessage')}
      variant="primary"
      size="small"
      type="submit"
      disabled={sending || draft.trim() === ''}
    >
      <PaperPlaneRightIcon />
    </IconButton>
  </form>
  {#if sendFailed}
    <p class="profile-composer-error" role="status">{$i18n.t('timeline.sendFailed')}</p>
  {/if}
{/snippet}

{#snippet miscData()}
  <details
    class="profile-extra"
    ontoggle={(event) => {
      miscOpen = event.currentTarget.open;
    }}
  >
    <summary>
      <CaretRightIcon />
      {miscOpen
        ? $i18n.t('timeline.profileHideMiscData', { count: extra.length })
        : $i18n.t('timeline.profileMiscData', { count: extra.length })}
    </summary>
    <dl>
      {#each extra as field (field.key)}
        <dt>{field.key}</dt>
        <dd>{field.value}</dd>
      {/each}
    </dl>
  </details>
{/snippet}

<ProfileCard
  {displayName}
  {userId}
  {avatarUrl}
  {color}
  heroColor={currentProfile?.hero_color}
  heroBrightness={currentProfile?.hero_brightness}
  bannerUrl={currentProfile?.banner_url}
  status={currentProfile?.status?.text}
  statusEmoji={currentProfile?.status?.emoji}
  nameColorLight={currentProfile?.name_color_light}
  nameColorDark={currentProfile?.name_color_dark}
  bioMoreLabel={shared ? undefined : $i18n.t('timeline.profileBioMore')}
  bioLessLabel={shared ? undefined : $i18n.t('timeline.profileBioLess')}
  meta={profileLoading ? metaPlaceholder : hasMeta ? metaRow : undefined}
  actions={actionRow}
  children={shared ? sharedPanel : showFailure || currentProfile?.bio ? bioPanel : undefined}
  footer={!shared && extra.length > 0 ? miscData : undefined}
  composer={canMessage ? composer : undefined}
  {variant}
/>

<DialogFrame
  open={moderationAction !== null}
  onOpenChange={(next) => {
    if (!next) cancelModeration();
  }}
  variant="verification"
  label={moderationAction === 'ban'
    ? $i18n.t('timeline.profileBan')
    : $i18n.t('timeline.profileKick')}
>
  {#if moderationAction}
    <div class="moderation">
      <h2>
        {moderationAction === 'ban'
          ? $i18n.t('timeline.profileBanConfirm', { name: displayName })
          : $i18n.t('timeline.profileKickConfirm', { name: displayName })}
      </h2>
      {#if moderationFailed}
        <Alert variant="critical" role="alert">{$i18n.t('timeline.profileModerationFailed')}</Alert>
      {/if}
      <FormField fieldId={moderationFieldId} label={$i18n.t('timeline.deleteReason')}>
        <TextInput id={moderationFieldId} bind:value={moderationReason} autocomplete="off" />
      </FormField>
      <div class="moderation-actions">
        <Button variant="ghost" onclick={cancelModeration}>{$i18n.t('timeline.cancel')}</Button>
        <Button variant="danger" loading={moderationBusy} onclick={confirmModeration}>
          {moderationAction === 'ban'
            ? $i18n.t('timeline.profileBan')
            : $i18n.t('timeline.profileKick')}
        </Button>
      </div>
    </div>
  {/if}
</DialogFrame>

<style>
  .profile-meta-item {
    align-items: start;
    display: inline-flex;
    gap: var(--space-100);
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .profile-meta-item :global(svg) {
    margin-top: var(--space-050);
  }

  .profile-meta-aside {
    color: var(--sable-sec-main);
  }

  .profile-meta-elevated {
    color: var(--sable-bg-on-container);
    font-weight: var(--font-weight-medium);
  }

  .profile-meta-elevated :global(svg) {
    color: var(--sable-bg-on-container);
  }

  :global(.profile-action) {
    align-items: center;
    background: none;
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-bg-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    justify-content: center;
    min-height: 2rem;
    padding: 0 var(--space-300);
    white-space: nowrap;
  }

  :global(.sable-profile-card-sheet .profile-action) {
    min-height: 2.75rem;
  }

  :global(.profile-action svg) {
    color: var(--sable-sec-main);
    flex: none;
  }

  :global(.profile-action:hover:not([aria-expanded='true'])) {
    background: color-mix(in oklab, var(--sable-bg-on-container) 7%, transparent);
  }

  :global(.profile-action:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.profile-action-overflow) {
    margin-left: auto;
    padding: var(--space-050) var(--space-200);
  }

  :global(.profile-power-name) {
    flex: 1;
  }

  :global(.profile-power-level) {
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  :global(.profile-menu-destructive) {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
    margin-top: var(--space-100);
  }

  :global(.profile-menu-grouped) {
    border-top: 0;
    margin-top: 0;
  }

  .profile-composer {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .profile-composer :global(.profile-composer-input) {
    flex: 1 1 auto;
    font-size: max(var(--font-size-small), var(--font-size-input-min));
    height: var(--control-height-small);
    min-height: 0;
    min-width: 0;
    padding-block: 0;
  }

  :global(.sable-profile-card-sheet) .profile-composer :global(.profile-composer-input) {
    height: var(--control-height-medium);
  }

  :global(.sable-profile-card-sheet) .profile-composer :global(.sable-icon-button) {
    min-height: var(--control-height-medium);
    width: var(--control-height-medium);
  }

  .profile-composer-error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    margin: var(--space-200) 0 0;
  }

  .profile-extra {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .profile-extra summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    min-height: 2.75rem;
    padding: 0 var(--space-300);
  }

  .profile-extra summary::-webkit-details-marker {
    display: none;
  }

  .profile-extra summary:hover {
    color: var(--sable-bg-on-container);
  }

  .profile-extra summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .profile-extra summary :global(svg) {
    color: var(--sable-sec-main);
    flex: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .profile-extra summary :global(svg) {
      transition: transform var(--motion-fast) var(--motion-easing-standard);
    }
  }

  .profile-extra[open] summary :global(svg) {
    transform: rotate(90deg);
  }

  .profile-extra dl {
    display: grid;
    gap: var(--space-050);
    margin: 0;
    padding: 0 var(--space-300) var(--space-300);
  }

  .profile-extra dt {
    color: var(--sable-sec-main);
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  .profile-extra dd {
    margin: 0 0 var(--space-200);
    overflow-wrap: anywhere;
  }

  .moderation {
    display: grid;
    gap: var(--space-300);
    width: min(27rem, calc(100vw - 2rem));
  }

  .moderation h2 {
    font-size: var(--font-size-heading);
    line-height: 1.3;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .moderation-actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
