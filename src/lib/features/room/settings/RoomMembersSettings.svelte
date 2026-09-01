<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import type { MembershipView } from '#src/generated/MembershipView';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import MemberIdentityRow from '../MemberIdentityRow.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import '#lib/ui/primitives/settings-row.css';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
  }

  let { room, permissions }: Props = $props();
  const core = useCoreClient();
  const presenceStore = usePresenceStore();

  const tabs: readonly { id: MembershipView; label: string }[] = [
    { id: 'join', label: 'room.membersJoined' },
    { id: 'invite', label: 'room.membersInvited' },
    { id: 'ban', label: 'room.membersBanned' },
  ];
  const powerChoices: readonly { level: number; label: string }[] = [
    { level: 100, label: 'timeline.powerLevelAdmin' },
    { level: 50, label: 'timeline.powerLevelModerator' },
    { level: 0, label: 'timeline.powerLevelMember' },
    { level: -1, label: 'timeline.powerLevelMuted' },
  ];

  let tab = $state<MembershipView>('join');
  let search = $state('');
  let members = $state.raw<MemberView[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let busy = $state<string | null>(null);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let ownPowerLevel = $derived(permissions?.own_power_level ?? 0);
  let canSetPower = $derived(permissions?.can_change_power_levels ?? false);
  let sorted = $derived(
    [...members].toSorted(
      (left, right) =>
        right.power_level - left.power_level ||
        memberName(left).localeCompare(memberName(right), undefined, { sensitivity: 'base' })
    )
  );
  let shown = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sorted;
    return sorted.filter(
      (member) =>
        memberName(member).toLocaleLowerCase().includes(query) ||
        member.user_id.toLocaleLowerCase().includes(query)
    );
  });

  $effect(() => {
    void tab;
    void roomId;
    void load();
  });

  function memberName(member: MemberView): string {
    return member.display_name ?? member.user_id;
  }

  async function load(): Promise<void> {
    const target = roomId;
    const membership = tab;
    if (!target) return;

    const current = ++run;
    loading = true;
    failed = false;
    try {
      const loaded = await core.commands.roomMembers(target, [membership]);
      if (current !== run) return;
      members = loaded;
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

  async function act(userId: string, action: () => Promise<void>): Promise<void> {
    busy = userId;
    try {
      await action();
      await load();
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
    void act(member.user_id, () => core.commands.setUserPowerLevel(target, member.user_id, level));
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
    {#each tabs as entry (entry.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === entry.id}
        class:active={tab === entry.id}
        onclick={() => {
          tab = entry.id;
          search = '';
        }}
      >
        {$i18n.t(entry.label)}
      </button>
    {/each}
  </div>

  <TextInput
    bind:value={search}
    type="search"
    placeholder={$i18n.t('timeline.searchMembers')}
    aria-label={$i18n.t('timeline.searchMembers')}
  />

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.membersFailed')}</Alert>
  {/if}

  {#if loading && members.length === 0}
    <p class="status" role="status"><Spinner small /></p>
  {:else if shown.length === 0}
    <p class="status">{$i18n.t('timeline.noMembersFound')}</p>
  {:else}
    <SettingsSection
      headingId="room-settings-members"
      title={$i18n.t('timeline.memberCount', { count: shown.length })}
    >
      <ul class="settings-rows">
        {#each shown as member (member.user_id)}
          {@const presence = presenceStore.get(member.user_id)}
          <li class="settings-row">
            <MemberIdentityRow class="member" userId={member.user_id} members={shown}>
              {#snippet trailing()}
                {#if presence}
                  <span class="member-presence">
                    <PresenceDot
                      presence={presence.presence}
                      label={$i18n.t(`presence.${presence.presence}`)}
                    />
                  </span>
                {/if}
                <span class="user-id">{member.user_id}</span>
              {/snippet}
            </MemberIdentityRow>
            <div class="settings-row-control">
              {#if tab === 'ban'}
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
            </div>
          </li>
        {/each}
      </ul>
    </SettingsSection>
  {/if}
</div>

<DialogFrame
  open={moderationTarget !== null}
  onOpenChange={(next) => {
    if (!next) cancelModeration();
  }}
  variant="verification"
  label={moderationTarget?.action === 'ban'
    ? $i18n.t('timeline.profileBan')
    : $i18n.t('timeline.profileKick')}
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
        <Button variant="ghost" disabled={moderationBusy} onclick={cancelModeration}>
          {$i18n.t('timeline.cancel')}
        </Button>
        <Button
          variant="danger"
          loading={moderationBusy}
          onclick={() => {
            void confirmModeration();
          }}
        >
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
    gap: var(--space-300);
  }

  .tabs {
    display: flex;
    gap: var(--space-200);
  }

  .tabs button {
    background: transparent;
    border: 0;
    border-bottom: var(--border-width-500) solid transparent;
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding: var(--space-200) var(--space-300);
  }

  .tabs button.active {
    border-bottom-color: var(--sable-primary-main);
    color: var(--sable-bg-on-container);
  }

  .tabs button:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .status {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-400) 0;
    text-align: center;
  }

  .settings-row :global(.member-identity-row.member) {
    flex: 1;
    min-width: 0;
  }

  .user-id {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .member-presence {
    align-items: center;
    display: inline-flex;
    margin-right: var(--space-100);
  }

  .power {
    color: var(--sable-surface-var-on-container);
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
