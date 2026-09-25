<script lang="ts">
  import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUpIcon';
  import type {
    MemberView,
    ProfileView,
    RoomPermissionsView,
    RoomSummary,
    UserDirectoryEntryView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import MemberIdentityRow from '../MemberIdentityRow.svelte';
  import {
    MEMBERSHIP_FILTERS,
    MEMBERSHIP_FILTER_LABELS,
    MEMBER_SORTS,
    MEMBER_SORT_LABELS,
    groupMembers,
    matchesFilter,
    membershipFor,
    type MembershipFilter,
  } from '../member-listing';
  import MentionProfile from '../MentionProfile.svelte';
  import { powerTag } from '../power-tags';
  import RoleTagIcon from '../RoleTagIcon.svelte';
  import RoomInviteDialog from '../RoomInviteDialog.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import '#lib/ui/primitives/settings-row.css';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import {
    parsePowerLevelTags,
    POWER_LEVEL_TAGS_EVENT_TYPE,
    type PowerLevelTagMap,
  } from './power-level-tags';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
  }

  let { room, permissions }: Props = $props();
  const core = useCoreClient();

  const powerChoices: readonly { level: number; label: string }[] = [
    { level: 100, label: 'timeline.powerLevelAdmin' },
    { level: 50, label: 'timeline.powerLevelModerator' },
    { level: 0, label: 'timeline.powerLevelMember' },
    { level: -1, label: 'timeline.powerLevelMuted' },
  ];

  const userIdPattern = /^@[^:\s]+:\S+$/;
  const noMembers: MemberView[] = [];

  let tab = $state<MembershipFilter>('join');
  let search = $state('');
  let members = $state.raw<MemberView[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let busy = $state<string | null>(null);
  let inviteOpen = $state(false);
  let directory = $state.raw<UserDirectoryEntryView[]>([]);
  let searching = $state(false);
  let inviting = $state<string | null>(null);
  let invitedIds = $state.raw<string[]>([]);
  let inviteFailed = $state(false);
  let powerTags = $state.raw<PowerLevelTagMap>({});
  let profileUserId = $state<string | null>(null);
  let profileAnchor = $state<HTMLElement | null>(null);
  let profile = $state<ProfileView | null>(null);
  let profileFailed = $state(false);
  let run = 0;
  let lookup = 0;
  let profileRequest = 0;

  let roomId = $derived(room?.room_id ?? null);
  let ownPowerLevel = $derived(permissions?.own_power_level ?? 0);
  let canSetPower = $derived(permissions?.can_change_power_levels ?? false);
  let isDirect = $derived(room?.is_direct ?? false);
  let canInviteInline = $derived((permissions?.can_invite ?? false) && !isDirect && tab !== 'ban');
  let inviteQuery = $derived(canInviteInline ? search.trim() : '');
  let candidates = $derived.by(() => {
    const typed =
      userIdPattern.test(inviteQuery) && !directory.some((entry) => entry.user_id === inviteQuery)
        ? [{ user_id: inviteQuery, display_name: null, avatar_url: null }]
        : [];
    return [...typed, ...directory].filter(
      (entry) => !members.some((member) => member.user_id === entry.user_id)
    );
  });
  let sort = $derived(preferences.memberSort);
  let shown = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return members;
    return members.filter(
      (member) =>
        memberName(member).toLocaleLowerCase().includes(query) ||
        member.user_id.toLocaleLowerCase().includes(query)
    );
  });

  let groups = $derived(groupMembers(shown, sort, () => true));

  $effect(() => {
    void tab;
    void roomId;
    void load();
  });

  $effect(() => {
    const target = roomId;
    if (!target) return;
    let current = true;
    void core.commands
      .roomStateEvent(target, POWER_LEVEL_TAGS_EVENT_TYPE)
      .then((content) => {
        if (current) powerTags = parsePowerLevelTags(content);
      })
      .catch(() => {
        if (current) powerTags = {};
      });
    return () => {
      current = false;
    };
  });

  function openProfile(userId: string, anchor: HTMLElement): void {
    const request = ++profileRequest;
    profileUserId = userId;
    profileAnchor = anchor;
    profile = null;
    profileFailed = false;
    void core
      .userProfile(userId)
      .then((next) => {
        if (request === profileRequest) profile = next;
      })
      .catch(() => {
        if (request === profileRequest) profileFailed = true;
      });
  }

  function closeProfile(): void {
    profileRequest += 1;
    profileUserId = null;
    profileAnchor = null;
  }

  $effect(() => {
    const query = inviteQuery;
    const current = ++lookup;
    searching = query !== '';
    if (!query) {
      directory = [];
      return;
    }
    const timer = setTimeout(() => {
      void findUsers(query, current);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  });

  async function findUsers(query: string, current: number): Promise<void> {
    try {
      const { results } = await core.commands.searchUserDirectory(query, 10);
      if (current === lookup) directory = results;
    } catch (error) {
      console.warn('[sable room] user directory unavailable', error);
      if (current === lookup) directory = [];
    } finally {
      if (current === lookup) searching = false;
    }
  }

  async function invite(userId: string): Promise<void> {
    const target = roomId;
    if (!target || inviting) return;

    inviting = userId;
    inviteFailed = false;
    try {
      await core.commands.inviteUser(target, userId);
      invitedIds = [...invitedIds, userId];
      await load();
    } catch (error) {
      console.warn('[sable room] invite failed', error);
      inviteFailed = true;
    } finally {
      inviting = null;
    }
  }

  function memberName(member: MemberView): string {
    return member.display_name ?? member.user_id;
  }

  async function load(): Promise<void> {
    const target = roomId;
    const filter = tab;
    if (!target) return;

    const current = ++run;
    loading = true;
    failed = false;
    try {
      const loaded = await core.commands.roomMembers(target, [membershipFor(filter)]);
      if (current !== run) return;
      members = loaded.filter((member) => matchesFilter(member, filter));
    } catch (error) {
      console.warn('[sable room] members unavailable', error);
      if (current === run) failed = true;
    } finally {
      if (current === run) loading = false;
    }
  }

  function outranked(member: MemberView): boolean {
    return member.power_level >= ownPowerLevel;
  }

  async function act(
    userId: string,
    action: () => Promise<void>,
    patch?: (member: MemberView) => MemberView
  ): Promise<void> {
    busy = userId;
    try {
      await action();
      await load();
      if (patch)
        members = members.map((entry) => (entry.user_id === userId ? patch(entry) : entry));
    } catch (error) {
      console.warn('[sable room] member action failed', error);
      failed = true;
    } finally {
      busy = null;
    }
  }

  function powerLabel(level: number): string {
    if (level >= 100) return $i18n.t('timeline.powerLevelAdmin');
    if (level >= 50) return $i18n.t('timeline.powerLevelModerator');
    if (level < 0) return $i18n.t('timeline.powerLevelMuted');
    return $i18n.t('timeline.powerLevelMember');
  }

  function powerOptions(member: MemberView): { value: string; label: string }[] {
    const known = powerChoices.map((choice) => ({
      value: String(choice.level),
      label: $i18n.t(choice.label),
    }));
    const current = String(member.power_level);
    if (known.some((option) => option.value === current)) return known;
    return [{ value: current, label: current }, ...known];
  }

  function setPower(member: MemberView, level: number): void {
    const target = roomId;
    if (!target || level === member.power_level) return;
    void act(
      member.user_id,
      () => core.commands.setUserPowerLevel(target, member.user_id, level),
      (entry) => ({ ...entry, power_level: level })
    );
  }

  let moderationTarget = $state<{ userId: string; action: 'kick' | 'ban' } | null>(null);
  let moderationReason = $state('');
  let moderationBusy = $state(false);
  let moderationMember = $derived.by(() => {
    const target = moderationTarget;
    if (target === null) return null;
    return members.find((member) => member.user_id === target.userId) ?? null;
  });

  function openModeration(userId: string, action: 'kick' | 'ban'): void {
    moderationTarget = { userId, action };
    moderationReason = '';
  }

  function cancelModeration(): void {
    moderationTarget = null;
    moderationReason = '';
  }

  function submitModeration(): void {
    void confirmModeration();
  }

  async function confirmModeration(): Promise<void> {
    const target = moderationTarget;
    const room = roomId;
    if (!target || !room || moderationBusy) return;

    const reason = moderationReason.trim() || null;
    moderationBusy = true;
    try {
      await act(target.userId, () =>
        target.action === 'kick'
          ? core.commands.kickUser(room, target.userId, reason)
          : core.commands.banUser(room, target.userId, reason)
      );
    } finally {
      moderationBusy = false;
      moderationTarget = null;
      moderationReason = '';
    }
  }
</script>

<div class="section">
  <div class="tabs" role="tablist" aria-label={$i18n.t('room.settingsMembers')}>
    {#each MEMBERSHIP_FILTERS as entry (entry)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === entry}
        class="choice"
        onclick={() => {
          tab = entry;
          search = '';
        }}
      >
        {$i18n.t(MEMBERSHIP_FILTER_LABELS[entry])}
      </button>
    {/each}
    <div class="sort">
      <ActionMenu label={$i18n.t('timeline.memberSort')}>
        {#snippet trigger({ props })}
          <Button {...props} variant="secondary" aria-label={$i18n.t('timeline.memberSort')}>
            <ArrowsDownUpIcon aria-hidden="true" />
            {$i18n.t(MEMBER_SORT_LABELS[sort])}
          </Button>
        {/snippet}
        {#each MEMBER_SORTS as option (option)}
          <ActionMenuItem
            checked={sort === option}
            onSelect={() => {
              setPreference('memberSort', option);
            }}
          >
            {$i18n.t(MEMBER_SORT_LABELS[option])}
          </ActionMenuItem>
        {/each}
      </ActionMenu>
    </div>
  </div>

  <div class="search">
    <TextInput
      bind:value={search}
      type="search"
      placeholder={canInviteInline
        ? $i18n.t('room.membersSearchOrInvite')
        : $i18n.t('timeline.searchMembers')}
      aria-label={canInviteInline
        ? $i18n.t('room.membersSearchOrInvite')
        : $i18n.t('timeline.searchMembers')}
    />
    {#if permissions?.can_invite && isDirect}
      <Button
        variant="secondary"
        onclick={() => {
          inviteOpen = true;
        }}
      >
        {$i18n.t('room.inviteTitle')}
      </Button>
    {/if}
  </div>

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.membersFailed')}</Alert>
  {/if}

  {#if loading && members.length === 0}
    <p class="settings-status" role="status"><Spinner small /></p>
  {:else if shown.length === 0}
    <p class="settings-status">{$i18n.t('timeline.noMembersFound')}</p>
  {:else}
    {#each groups as group (group.key)}
      {@const tag = powerTag(group.level ?? 0, $i18n.t, powerTags)}
      {#snippet tagIcon()}
        <RoleTagIcon icon={tag.icon ?? ''} />
      {/snippet}
      <SettingsSection
        headingId={`room-settings-members-${group.key}`}
        title={tag.name}
        description={$i18n.t('timeline.memberCount', { count: group.members.length })}
        icon={tag.icon ? tagIcon : undefined}
      >
        <ul class="settings-rows">
          {#each group.members as member (member.user_id)}
            <SettingsRow>
              {#snippet copy()}
                <MemberIdentityRow
                  userId={member.user_id}
                  members={shown}
                  powerTag={tag}
                  onProfile={openProfile}
                >
                  {#snippet trailing()}
                    <span class="user-id">{member.user_id}</span>
                  {/snippet}
                </MemberIdentityRow>
              {/snippet}
              {#if tab === 'leave' || tab === 'kick'}
                {#if permissions?.can_ban && !outranked(member)}
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy === member.user_id}
                    onclick={() => {
                      openModeration(member.user_id, 'ban');
                    }}
                  >
                    {$i18n.t('timeline.profileBan')}
                  </Button>
                {/if}
              {:else if tab === 'ban'}
                {#if permissions?.can_ban}
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy === member.user_id}
                    onclick={() => {
                      const target = roomId;
                      if (target)
                        void act(member.user_id, () =>
                          core.commands.unbanUser(target, member.user_id)
                        );
                    }}
                  >
                    {$i18n.t('timeline.profileUnban')}
                  </Button>
                {/if}
              {:else}
                {#if canSetPower && !outranked(member)}
                  <Select
                    value={String(member.power_level)}
                    aria-label={$i18n.t('timeline.profileChangePower')}
                    disabled={busy === member.user_id}
                    items={powerOptions(member)}
                    onValueChange={(next: string) => {
                      setPower(member, Number(next));
                    }}
                  />
                {:else}
                  <span class="power">{powerLabel(member.power_level)}</span>
                {/if}
                {#if permissions?.can_kick && !outranked(member)}
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy === member.user_id}
                    onclick={() => {
                      openModeration(member.user_id, 'kick');
                    }}
                  >
                    {$i18n.t('timeline.profileKick')}
                  </Button>
                {/if}
                {#if permissions?.can_ban && !outranked(member)}
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy === member.user_id}
                    onclick={() => {
                      openModeration(member.user_id, 'ban');
                    }}
                  >
                    {$i18n.t('timeline.profileBan')}
                  </Button>
                {/if}
              {/if}
            </SettingsRow>
          {/each}
        </ul>
      </SettingsSection>
    {/each}
  {/if}

  {#if inviteQuery}
    <SettingsSection
      headingId="room-settings-members-invite"
      title={$i18n.t('room.membersInviteHeading')}
    >
      {#if inviteFailed}
        <div class="settings-form">
          <Alert variant="critical" role="alert">{$i18n.t('room.inviteSendFailed')}</Alert>
        </div>
      {/if}
      {#if candidates.length > 0}
        <ul class="settings-rows">
          {#each candidates as entry (entry.user_id)}
            <SettingsRow>
              {#snippet copy()}
                <MemberIdentityRow userId={entry.user_id} members={noMembers}>
                  {#snippet trailing()}
                    <span class="user-id">{entry.user_id}</span>
                  {/snippet}
                </MemberIdentityRow>
              {/snippet}
              {#if invitedIds.includes(entry.user_id)}
                <span class="power">{$i18n.t('room.membersInvited')}</span>
              {:else}
                <Button
                  size="small"
                  variant="secondary"
                  loading={inviting === entry.user_id}
                  disabled={inviting !== null}
                  onclick={() => {
                    void invite(entry.user_id);
                  }}
                >
                  {$i18n.t('room.inviteSubmit')}
                </Button>
              {/if}
            </SettingsRow>
          {/each}
        </ul>
      {:else}
        <div class="settings-form">
          {#if searching}
            <p class="settings-note" role="status"><Spinner small /></p>
          {:else}
            <p class="settings-note">{$i18n.t('room.membersInviteEmpty')}</p>
          {/if}
        </div>
      {/if}
    </SettingsSection>
  {/if}
</div>

{#if roomId}
  <MentionProfile
    open={profileUserId !== null}
    onOpenChange={(open: boolean) => {
      if (!open) closeProfile();
    }}
    userId={profileUserId}
    anchor={profileAnchor}
    member={members.find((member) => member.user_id === profileUserId) ?? null}
    {roomId}
    {ownPowerLevel}
    {permissions}
    {powerTags}
    {profile}
    failed={profileFailed}
    onPowerLevelChange={() => void load()}
  />
{/if}

<RoomInviteDialog
  open={inviteOpen}
  {room}
  onOpenChange={(open: boolean) => {
    inviteOpen = open;
    if (!open) void load();
  }}
/>

<DialogFrame
  open={moderationTarget !== null}
  onOpenChange={(next) => {
    if (!next) cancelModeration();
  }}
  variant="verification"
  label={moderationTarget?.action === 'ban'
    ? $i18n.t('timeline.profileBan')
    : $i18n.t('timeline.profileKick')}
  onConfirm={submitModeration}
>
  {#if moderationTarget}
    <div class="moderation">
      <h2>
        {moderationTarget.action === 'ban'
          ? $i18n.t('timeline.profileBanConfirm', {
              name: moderationMember ? memberName(moderationMember) : moderationTarget.userId,
            })
          : $i18n.t('timeline.profileKickConfirm', {
              name: moderationMember ? memberName(moderationMember) : moderationTarget.userId,
            })}
      </h2>
      <FormField fieldId="member-moderation-reason" label={$i18n.t('timeline.deleteReason')}>
        <TextInput id="member-moderation-reason" bind:value={moderationReason} autocomplete="off" />
      </FormField>
      <div class="moderation-actions">
        <Button type="button" variant="ghost" disabled={moderationBusy} onclick={cancelModeration}>
          {$i18n.t('timeline.cancel')}
        </Button>
        <Button type="submit" variant="danger" loading={moderationBusy}>
          {moderationTarget.action === 'ban'
            ? $i18n.t('timeline.profileBan')
            : $i18n.t('timeline.profileKick')}
        </Button>
      </div>
    </div>
  {/if}
</DialogFrame>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }

  .tabs {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .sort {
    margin-inline-start: auto;
  }

  .search {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .search > :global(.text-input) {
    flex: 1;
    min-width: 0;
  }

  .user-id {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .power {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
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
