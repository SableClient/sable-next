<script lang="ts">
  import { untrack } from 'svelte';
  import type { JoinRuleView } from '@/generated/JoinRuleView';
  import type { RoomPermissionsView } from '@/generated/RoomPermissionsView';
  import type { RoomSummary } from '@/generated/RoomSummary';
  import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
  import HandIcon from 'phosphor-svelte/lib/HandIcon';
  import LockIcon from 'phosphor-svelte/lib/LockIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import OptionCards from '$lib/ui/primitives/OptionCards.svelte';
  import SettingsSection from '$lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '$lib/ui/primitives/TextArea.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  import { initials } from './timeline-format';

  interface Props {
    open: boolean;
    room: RoomSummary | null;
    onOpenChange: (open: boolean) => void;
  }

  let { open, room, onOpenChange }: Props = $props();
  const core = useCoreClient();
  const settableRules: JoinRuleView[] = ['public', 'invite', 'knock'];
  let permissions = $state<RoomPermissionsView | null>(null);

  let name = $state('');
  let topicDraft = $state('');
  let pendingRule = $state<JoinRuleView | null>(null);
  let saving = $state(false);
  let saved = $state(false);
  let failed = $state(false);
  let avatarInput = $state<HTMLInputElement | null>(null);

  let roomId = $derived(room?.room_id ?? null);
  let topic = $derived(room?.topic ?? '');
  let savedRule = $derived(settableRules.find((rule) => rule === room?.join_rule) ?? null);
  let joinRule = $derived<JoinRuleView | null>(pendingRule ?? savedRule);
  let unsettableRule = $derived(joinRule === null);
  let dirty = $derived(
    name !== (room?.name ?? '') ||
      topicDraft !== topic ||
      (pendingRule !== null && pendingRule !== savedRule)
  );
  let canEditGeneral = $derived(permissions?.can_change_settings ?? false);
  let canEditAccess = $derived(permissions?.can_change_join_rule ?? false);
  let readOnly = $derived(permissions !== null && !canEditGeneral && !canEditAccess);

  // Reopening on another room would otherwise keep the previous room's draft.
  // Only the identity of the room may retrigger this: reading the values it
  // seeds from would make a successful save reset its own confirmation.
  $effect(() => {
    void roomId;
    if (!open) return;
    untrack(() => {
      name = room?.name ?? '';
      topicDraft = topic;
      pendingRule = null;
      saved = false;
      failed = false;
    });
  });

  $effect(() => {
    const target = roomId;
    if (!open || !target) return;

    let current = true;
    permissions = null;
    void core
      .roomPermissions(target)
      .then((next) => {
        if (current) permissions = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] permissions unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  async function run(action: () => Promise<void>): Promise<void> {
    saving = true;
    saved = false;
    failed = false;
    try {
      await action();
      saved = true;
    } catch (error) {
      console.warn('[sable room] settings change failed', error);
      failed = true;
    } finally {
      saving = false;
    }
  }

  async function save(): Promise<void> {
    const target = roomId;
    if (!target) return;
    await run(async () => {
      if (name !== (room?.name ?? '')) {
        await core.setRoomName(target, name.trim() === '' ? null : name.trim());
      }
      if (topicDraft !== topic) await core.setRoomTopic(target, topicDraft.trim());
      if (pendingRule !== null && pendingRule !== savedRule) {
        await core.setRoomJoinRule(target, pendingRule);
      }
    });
  }

  function selectJoinRule(rule: JoinRuleView): void {
    pendingRule = rule;
    saved = false;
  }

  /** One-directional, like v1: a DM becomes a group. */
  function convertToGroup(): void {
    const target = roomId;
    if (!target) return;
    void run(async () => {
      await core.setDirect(target, false);
    });
  }

  async function uploadAvatar(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const target = roomId;
    if (!file || !target) return;

    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await core.uploadRoomAvatar(target, file.type || 'image/*', bytes);
    });
  }

  function removeAvatar(): void {
    const target = roomId;
    if (!target) return;
    void run(async () => {
      await core.setRoomAvatar(target, null);
    });
  }
</script>

<DialogFrame {open} {onOpenChange} variant="settings" label={$i18n.t('room.settingsTitle')}>
  <div class="room-settings">
    <header>
      <h2>{$i18n.t('room.settingsTitle')}</h2>
      <IconButton
        variant="ghost"
        size="small"
        label={$i18n.t('room.settingsClose')}
        onclick={() => {
          onOpenChange(false);
        }}
      >
        <XIcon />
      </IconButton>
    </header>

    <div class="room-settings-body">
      {#if readOnly}
        <Alert variant="info" role="status">{$i18n.t('room.settingsReadOnly')}</Alert>
      {/if}
      <SettingsSection
        headingId="room-settings-general"
        title={$i18n.t('room.settingsGeneral')}
        description={$i18n.t('room.settingsGeneralDescription')}
      >
        <div class="panel">
          <div class="avatar-row">
            <Avatar
              src={room?.avatar_url ?? null}
              initials={initials(room?.name ?? '')}
              size="large"
              shape="room"
            />
            <div class="avatar-actions">
              <span class="field-label">{$i18n.t('room.settingsAvatarLabel')}</span>
              <p class="hint">{$i18n.t('room.settingsAvatarHint')}</p>
              <div class="buttons">
                <Button
                  size="small"
                  disabled={!canEditGeneral || saving}
                  onclick={() => avatarInput?.click()}
                >
                  {$i18n.t('room.settingsAvatarChange')}
                </Button>
                {#if room?.avatar_url}
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={!canEditGeneral || saving}
                    onclick={removeAvatar}
                  >
                    {$i18n.t('room.settingsAvatarRemove')}
                  </Button>
                {/if}
              </div>
            </div>
            <input
              bind:this={avatarInput}
              class="avatar-input"
              type="file"
              accept="image/*"
              tabindex="-1"
              aria-hidden="true"
              onchange={uploadAvatar}
            />
          </div>

          <div class="field">
            <Label for="room-settings-name">{$i18n.t('room.settingsNameLabel')}</Label>
            <TextInput id="room-settings-name" bind:value={name} disabled={!canEditGeneral} />
          </div>

          <div class="field">
            <Label for="room-settings-topic">{$i18n.t('room.settingsTopicLabel')}</Label>
            <TextArea id="room-settings-topic" bind:value={topicDraft} disabled={!canEditGeneral} />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        headingId="room-settings-access"
        title={$i18n.t('room.settingsAccess')}
        description={$i18n.t('room.settingsAccessDescription')}
      >
        <div class="panel">
          {#if unsettableRule && canEditAccess}
            <Alert variant="warning" role="status">
              {$i18n.t('room.settingsJoinRuleUnsettable', {
                rule: $i18n.t(`room.joinRule.${room?.join_rule ?? 'unknown'}`),
              })}
            </Alert>
          {/if}
          <OptionCards
            label={$i18n.t('room.settingsAccess')}
            value={joinRule}
            disabled={!canEditAccess || saving}
            onSelect={selectJoinRule}
            options={[
              {
                value: 'public',
                label: $i18n.t('room.settingsJoinRulePublic'),
                hint: $i18n.t('room.settingsJoinRulePublicHint'),
                icon: GlobeIcon,
              },
              {
                value: 'invite',
                label: $i18n.t('room.settingsJoinRuleInvite'),
                hint: $i18n.t('room.settingsJoinRuleInviteHint'),
                icon: LockIcon,
              },
              {
                value: 'knock',
                label: $i18n.t('room.settingsJoinRuleKnock'),
                hint: $i18n.t('room.settingsJoinRuleKnockHint'),
                icon: HandIcon,
              },
            ]}
          />

          {#if room?.is_direct}
            <div class="row">
              <div class="row-text">
                <span class="field-label">{$i18n.t('room.settingsDirectLabel')}</span>
                <p class="hint">{$i18n.t('room.settingsDirectHint')}</p>
              </div>
              <Button size="small" disabled={saving} onclick={convertToGroup}>
                {$i18n.t('room.menuConvertToGroup')}
              </Button>
            </div>
          {/if}
        </div>
      </SettingsSection>
    </div>

    <footer>
      {#if failed}
        <p class="footer-status error" role="alert">{$i18n.t('room.settingsFailed')}</p>
      {:else if saved}
        <p class="footer-status" role="status">{$i18n.t('room.settingsSaved')}</p>
      {/if}
      <Button variant="primary" disabled={!dirty || saving} loading={saving} onclick={save}>
        {$i18n.t('room.settingsSave')}
      </Button>
    </footer>
  </div>
</DialogFrame>

<style>
  .room-settings {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  header {
    align-items: center;
    border-bottom: 1px solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 auto;
    justify-content: space-between;
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .room-settings-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow: auto;
    padding: var(--space-3);
  }

  /* SettingsSection sets `overflow: hidden`, which gives it an automatic
     minimum size of zero. Left shrinkable it gets compressed to fit and then
     clips its own content. */
  .room-settings-body > :global(*) {
    flex: none;
  }

  footer {
    align-items: center;
    border-top: 1px solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-2);
    justify-content: flex-end;
    padding: var(--space-2) var(--space-3);
  }

  .footer-status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    margin-right: auto;
  }

  .footer-status.error {
    color: var(--sable-crit-main);
  }

  .panel {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .field-label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .avatar-row {
    align-items: center;
    display: flex;
    gap: var(--space-3);
  }

  .avatar-actions {
    display: grid;
    gap: calc(var(--space-1) / 2);
    min-width: 0;
  }

  .avatar-input {
    height: 0;
    opacity: 0;
    position: absolute;
    width: 0;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .row {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
  }

  .row-text {
    display: grid;
    gap: calc(var(--space-1) / 2);
    min-width: 0;
  }
</style>
