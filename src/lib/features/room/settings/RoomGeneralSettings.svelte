<script lang="ts">
  import { untrack } from 'svelte';
  import type { JoinRuleView } from '#src/generated/JoinRuleView';
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
  import HandIcon from 'phosphor-svelte/lib/HandIcon';
  import LockIcon from 'phosphor-svelte/lib/LockIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import '#lib/ui/primitives/settings-row.css';

  import { bannerChanges, readRoomBanner, setRoomBanner } from '../room-banner.svelte.js';
  import RoomAddressSettings from './RoomAddressSettings.svelte';
  import RoomEncryptionSettings from './RoomEncryptionSettings.svelte';
  import RoomHistorySettings from './RoomHistorySettings.svelte';
  import RoomPublishSettings from './RoomPublishSettings.svelte';
  import RoomUpgradeSettings from './RoomUpgradeSettings.svelte';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
    onClose: () => void;
  }

  let { room, permissions, levels, onClose }: Props = $props();
  const core = useCoreClient();

  let name = $state('');
  let topicDraft = $state('');
  let pendingRule = $state<JoinRuleView | null>(null);
  let saving = $state(false);
  let saved = $state(false);
  let failed = $state(false);
  let avatarInput = $state<HTMLInputElement | null>(null);
  let bannerInput = $state<HTMLInputElement | null>(null);
  let banner = $state<string | null>(null);

  let roomId = $derived(room?.room_id ?? null);
  let topic = $derived(room?.topic ?? '');
  let settableRules = $derived.by(() => {
    const rules: JoinRuleView[] = ['public', 'invite'];
    if (room?.supports_knock) rules.push('knock');
    if (room?.has_space_parent && room.supports_restricted) rules.push('restricted');
    if (room?.has_space_parent && room.supports_knock_restricted) {
      rules.push('knock_restricted');
    }
    return rules;
  });
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
  let ownPowerLevel = $derived(permissions?.own_power_level ?? 0);

  $effect(() => {
    void roomId;
    untrack(() => {
      name = room?.name ?? '';
      topicDraft = topic;
      pendingRule = null;
      saved = false;
      failed = false;
    });
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
        await core.commands.setRoomName(target, name.trim() === '' ? null : name.trim());
      }
      if (topicDraft !== topic) await core.commands.setRoomTopic(target, topicDraft.trim());
      if (pendingRule !== null && pendingRule !== savedRule) {
        await core.commands.setRoomJoinRule(target, pendingRule);
      }
    });
  }

  function selectJoinRule(rule: JoinRuleView): void {
    pendingRule = rule;
    saved = false;
  }

  function convertToGroup(): void {
    const target = roomId;
    if (!target) return;
    void run(async () => {
      await core.commands.setDirect(target, false);
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
      await core.commands.setRoomAvatar(target, null);
    });
  }

  $effect(() => {
    const target = roomId;
    void bannerChanges.version;
    if (!target) {
      banner = null;
      return;
    }

    let current = true;
    void readRoomBanner(core, target).then((next) => {
      if (current) banner = next;
    });
    return () => {
      current = false;
    };
  });

  async function uploadBanner(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const target = roomId;
    if (!file || !target) return;

    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const uri = await core.commands.uploadMedia(file.type || 'image/*', bytes);
      await setRoomBanner(core, target, uri);
    });
  }

  function removeBanner(): void {
    const target = roomId;
    if (!target) return;
    void run(async () => {
      await setRoomBanner(core, target, null);
    });
  }
</script>

<div class="section">
  <SettingsSection
    headingId="room-settings-general"
    title={$i18n.t('room.settingsGeneral')}
    description={$i18n.t('room.settingsGeneralDescription')}
  >
    <ul class="settings-rows">
      <li class="settings-row">
        <Avatar src={room?.avatar_url ?? null} name={room?.name ?? ''} />
        <div class="settings-row-copy">
          <span class="settings-row-name">{$i18n.t('room.settingsAvatarLabel')}</span>
          <p>{$i18n.t('room.settingsAvatarHint')}</p>
        </div>
        {#if canEditGeneral}
          <div class="settings-row-control">
            <Button size="small" disabled={saving} onclick={() => avatarInput?.click()}>
              {$i18n.t('room.settingsAvatarChange')}
            </Button>
            {#if room?.avatar_url}
              <Button size="small" variant="ghost" disabled={saving} onclick={removeAvatar}>
                {$i18n.t('room.settingsAvatarRemove')}
              </Button>
            {/if}
          </div>
        {/if}
        <input
          bind:this={avatarInput}
          class="avatar-input"
          type="file"
          accept="image/*"
          tabindex="-1"
          aria-hidden="true"
          onchange={uploadAvatar}
        />
      </li>
      <li class="settings-row">
        {#if banner}
          <MediaImage source={banner} alt="" width={160} height={90} class="banner-preview" />
        {/if}
        <div class="settings-row-copy">
          <span class="settings-row-name">{$i18n.t('room.settingsBannerLabel')}</span>
          <p>{$i18n.t('room.settingsBannerHint')}</p>
        </div>
        {#if canEditGeneral}
          <div class="settings-row-control">
            <Button size="small" disabled={saving} onclick={() => bannerInput?.click()}>
              {$i18n.t('room.settingsBannerChange')}
            </Button>
            {#if banner}
              <Button size="small" variant="ghost" disabled={saving} onclick={removeBanner}>
                {$i18n.t('room.settingsBannerRemove')}
              </Button>
            {/if}
          </div>
        {/if}
        <input
          bind:this={bannerInput}
          class="avatar-input"
          type="file"
          accept="image/*"
          tabindex="-1"
          aria-hidden="true"
          onchange={uploadBanner}
        />
      </li>
    </ul>
    {#if canEditGeneral}
      <div class="settings-form">
        <div class="settings-field">
          <Label for="room-settings-name">{$i18n.t('room.settingsNameLabel')}</Label>
          <TextInput id="room-settings-name" bind:value={name} />
        </div>
        <div class="settings-field">
          <Label for="room-settings-topic">{$i18n.t('room.settingsTopicLabel')}</Label>
          <TextArea id="room-settings-topic" bind:value={topicDraft} />
        </div>
      </div>
    {:else}
      <ul class="settings-rows">
        <li class="settings-row">
          <div class="settings-row-copy">
            <span class="settings-row-name">{$i18n.t('room.settingsNameLabel')}</span>
            <p>{room?.name ?? ''}</p>
          </div>
        </li>
        {#if topic !== ''}
          <li class="settings-row">
            <div class="settings-row-copy">
              <span class="settings-row-name">{$i18n.t('room.settingsTopicLabel')}</span>
              <p>{topic}</p>
            </div>
          </li>
        {/if}
      </ul>
    {/if}
  </SettingsSection>

  <SettingsSection
    headingId="room-settings-access"
    title={$i18n.t('room.settingsAccess')}
    description={$i18n.t('room.settingsAccessDescription')}
  >
    <div class="settings-form">
      {#if unsettableRule && canEditAccess}
        <Alert variant="warning" role="status">
          {$i18n.t('room.settingsJoinRuleUnsettable', {
            rule: $i18n.t(`room.joinRule.${room?.join_rule ?? 'unknown'}`),
          })}
        </Alert>
      {/if}
      {#if canEditAccess}
        <OptionCards
          label={$i18n.t('room.settingsAccess')}
          value={joinRule}
          disabled={saving}
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
            ...(room?.supports_knock
              ? [
                  {
                    value: 'knock' as const,
                    label: $i18n.t('room.settingsJoinRuleKnock'),
                    hint: $i18n.t('room.settingsJoinRuleKnockHint'),
                    icon: HandIcon,
                  },
                ]
              : []),
            ...(room?.has_space_parent && room.supports_restricted
              ? [
                  {
                    value: 'restricted' as const,
                    label: $i18n.t('room.settingsJoinRuleRestricted'),
                    hint: $i18n.t('room.settingsJoinRuleRestrictedHint'),
                    icon: LockIcon,
                  },
                ]
              : []),
            ...(room?.has_space_parent && room.supports_knock_restricted
              ? [
                  {
                    value: 'knock_restricted' as const,
                    label: $i18n.t('room.settingsJoinRuleKnockRestricted'),
                    hint: $i18n.t('room.settingsJoinRuleKnockRestrictedHint'),
                    icon: HandIcon,
                  },
                ]
              : []),
          ]}
        />
      {:else}
        <p class="read-only-value">
          {$i18n.t(`room.joinRule.${room?.join_rule ?? 'unknown'}`)}
        </p>
      {/if}
    </div>

    <ul class="settings-rows">
      {#if !room?.is_space}
        <RoomHistorySettings {room} {levels} {ownPowerLevel} />
        <RoomEncryptionSettings {room} {levels} {ownPowerLevel} />
      {/if}
      <RoomPublishSettings {room} {levels} {ownPowerLevel} />
      {#if room?.is_direct && canEditGeneral}
        <li class="settings-row">
          <div class="settings-row-copy">
            <span class="settings-row-name">{$i18n.t('room.settingsDirectLabel')}</span>
            <p>{$i18n.t('room.settingsDirectHint')}</p>
          </div>
          <div class="settings-row-control">
            <Button size="small" disabled={saving} onclick={convertToGroup}>
              {$i18n.t('room.menuConvertToGroup')}
            </Button>
          </div>
        </li>
      {/if}
    </ul>
  </SettingsSection>

  <RoomAddressSettings {room} {levels} {ownPowerLevel} />

  <RoomUpgradeSettings {room} {permissions} {onClose} />

  {#if canEditGeneral}
    <div class="save-bar">
      {#if failed}
        <p class="save-status error" role="alert">{$i18n.t('room.settingsFailed')}</p>
      {:else if saved}
        <p class="save-status" role="status">{$i18n.t('room.settingsSaved')}</p>
      {/if}
      <Button variant="primary" disabled={!dirty || saving} loading={saving} onclick={save}>
        {$i18n.t('room.settingsSave')}
      </Button>
    </div>
  {/if}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-300);
  }

  .read-only-value {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  :global(.banner-preview) {
    border-radius: var(--radius);
    flex: none;
    height: 2.5rem;
    object-fit: cover;
    overflow: hidden;
    width: 4.5rem;
  }

  .avatar-input {
    height: 0;
    opacity: 0;
    position: absolute;
    width: 0;
  }

  .save-bar {
    align-items: center;
    display: flex;
    gap: var(--space-400);
    justify-content: flex-end;
  }

  .save-status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    margin-right: auto;
  }

  .save-status.error {
    color: var(--sable-crit-main);
  }
</style>
