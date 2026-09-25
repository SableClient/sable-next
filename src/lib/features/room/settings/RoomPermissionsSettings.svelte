<script lang="ts">
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import ListChecksIcon from 'phosphor-svelte/lib/ListChecksIcon';
  import PencilIcon from 'phosphor-svelte/lib/PencilIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';

  import '#lib/ui/primitives/settings-row.css';

  import { ancestorSpaceIds, descendantRoomIds } from '../abbreviations.js';
  import MemberIdentityRow from '../MemberIdentityRow.svelte';
  import ReactionPicker from '../ReactionPicker.svelte';
  import RoleTagIcon from '../RoleTagIcon.svelte';
  import { readFounders } from './room-upgrade';
  import {
    canSendState,
    levelAt,
    permissionGroups,
    syncedFromSpace,
    toEventContent,
    withLevel,
    type PermissionLocation,
  } from './permission-groups';
  import {
    parsePowerLevelInput,
    parsePowerLevelTags,
    POWER_LEVEL_TAGS_EVENT_TYPE,
    tagForLevel,
    withPowerLevelTag,
    withPowerLevelTagsFrom,
    type PowerLevelTagMap,
  } from './power-level-tags';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
  }

  let { room, permissions }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  const namedLevels: readonly { level: number; label: string }[] = [
    { level: 100, label: 'timeline.powerLevelAdmin' },
    { level: 50, label: 'timeline.powerLevelModerator' },
    { level: 0, label: 'timeline.powerLevelMember' },
  ];

  let levels = $state.raw<RoomPowerLevelsView | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let saving = $state(false);
  let run = 0;

  let rawRoleTags = $state.raw<unknown>(null);
  let roleTags = $derived<PowerLevelTagMap>(parsePowerLevelTags(rawRoleTags));
  let founders = $state.raw<string[]>([]);
  let peekLevel = $state<number | null>(null);
  let iconUploading = $state(false);
  let iconInput = $state<HTMLInputElement | null>(null);
  let roleLevels = $derived(
    [
      ...new Set([
        ...Object.keys(roleTags).map(Number),
        ...namedLevels.map((entry) => entry.level),
      ]),
    ].sort((left, right) => right - left)
  );

  let numberDrafts = $state.raw<Record<string, string>>({});
  let numberErrors = $state.raw<Record<string, string>>({});

  let editingLevel = $state<number | null>(null);
  let editingNewRole = $state(false);
  let editingRole = $derived(editingNewRole || editingLevel !== null);
  let editingHasTag = $derived(
    editingLevel !== null && tagForLevel(roleTags, editingLevel) !== null
  );
  let roleLevelDraft = $state('');
  let roleLevelError = $state<string | null>(null);
  let roleNameDraft = $state('');
  let roleColorDraft = $state('');
  let roleIconDraft = $state('');
  let roleSaving = $state(false);
  let roleFailed = $state(false);
  let roleRemoveConfirm = $state(false);

  let roomId = $derived(room?.room_id ?? null);
  let groups = $derived(permissionGroups(room?.is_space ?? false));
  let canEdit = $derived(permissions?.can_change_power_levels ?? false);
  let ownLevel = $derived(permissions?.own_power_level ?? 0);

  let syncChoice = $state<string | null>(null);
  let syncConfirm = $state(false);
  let syncing = $state(false);
  let syncFailed = $state(false);
  let syncSpaceIds = $derived(
    roomId && !room?.is_space ? ancestorSpaceIds(roomList.rooms, roomId).reverse() : []
  );
  let syncSpaceId = $derived(
    syncChoice !== null && syncSpaceIds.includes(syncChoice)
      ? syncChoice
      : (syncSpaceIds[0] ?? null)
  );

  let childIds = $derived(
    roomId && room?.is_space ? descendantRoomIds(roomList.rooms, roomId) : []
  );
  let childConfirm = $state(false);
  let childSyncing = $state(false);
  let childResult = $state<{ updated: number; skipped: number } | null>(null);

  $effect(() => {
    void roomId;
    void load();
  });

  async function load(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    loading = true;
    failed = false;
    try {
      void loadFounders(target, current);
      const [loaded, tagsContent] = await Promise.all([
        core.commands.roomPowerLevels(target),
        core.commands.roomStateEvent(target, POWER_LEVEL_TAGS_EVENT_TYPE),
      ]);
      if (current !== run) return;
      levels = loaded;
      rawRoleTags = tagsContent ?? null;
    } catch (error) {
      console.warn('[sable room] power levels unavailable', error);
      if (current === run) failed = true;
    } finally {
      if (current === run) loading = false;
    }
  }

  async function loadFounders(target: string, current: number): Promise<void> {
    try {
      const events = await core.commands.roomStateEventsRaw(target, 'm.room.create', '');
      if (current === run) founders = readFounders(events[0]);
    } catch (error) {
      console.debug('[sable room] founders unavailable', error);
      if (current === run) founders = [];
    }
  }

  async function setLevel(location: PermissionLocation, level: number): Promise<void> {
    const target = roomId;
    const current = levels;
    if (!target || !current || saving) return;

    const next = withLevel(current, location, level);
    saving = true;
    failed = false;
    try {
      await core.commands.sendStateEvent(target, 'm.room.power_levels', '', toEventContent(next));
      levels = next;
    } catch (error) {
      console.warn('[sable room] permission change failed', error);
      failed = true;
    } finally {
      saving = false;
    }
  }

  function spaceName(spaceId: string): string {
    return roomList.byId(spaceId)?.name ?? spaceId;
  }

  async function syncFromSpace(): Promise<void> {
    const target = roomId;
    const spaceId = syncSpaceId;
    const current = levels;
    const userId = core.session?.user_id;
    if (!target || !spaceId || !current || !userId || syncing) return;

    syncing = true;
    syncFailed = false;
    try {
      const [spaceLevels, spaceTags] = await Promise.all([
        core.commands.roomPowerLevels(spaceId),
        core.commands.roomStateEvent(spaceId, POWER_LEVEL_TAGS_EVENT_TYPE),
      ]);
      const next = syncedFromSpace(current, spaceLevels, userId, ownLevel);
      await core.commands.sendStateEvent(target, 'm.room.power_levels', '', toEventContent(next));
      levels = next;
      if (spaceTags && canSendState(next, ownLevel, POWER_LEVEL_TAGS_EVENT_TYPE)) {
        const nextTags = withPowerLevelTagsFrom(rawRoleTags, spaceTags);
        await core.commands.sendStateEvent(target, POWER_LEVEL_TAGS_EVENT_TYPE, '', nextTags);
        rawRoleTags = nextTags;
      }
      syncConfirm = false;
    } catch (error) {
      console.warn('[sable room] permission sync failed', error);
      syncFailed = true;
    } finally {
      syncing = false;
    }
  }

  async function syncChildren(): Promise<void> {
    const space = levels;
    const userId = core.session?.user_id;
    if (!space || !userId || childSyncing) return;

    childSyncing = true;
    let updated = 0;
    let skipped = 0;
    for (const childId of childIds) {
      try {
        const current = await core.commands.roomPowerLevels(childId);
        const own = current.users[userId] ?? current.users_default;
        if (!canSendState(current, own, 'm.room.power_levels')) {
          skipped += 1;
          continue;
        }
        const next = syncedFromSpace(current, space, userId, own);
        const content = toEventContent(next);
        if (JSON.stringify(content) !== JSON.stringify(toEventContent(current))) {
          await core.commands.sendStateEvent(childId, 'm.room.power_levels', '', content);
        }
        if (rawRoleTags && canSendState(next, own, POWER_LEVEL_TAGS_EVENT_TYPE)) {
          const tags = await core.commands.roomStateEvent(childId, POWER_LEVEL_TAGS_EVENT_TYPE);
          await core.commands.sendStateEvent(
            childId,
            POWER_LEVEL_TAGS_EVENT_TYPE,
            '',
            withPowerLevelTagsFrom(tags, rawRoleTags)
          );
        }
        updated += 1;
      } catch (error) {
        console.warn('[sable room] child permission sync failed', error);
        skipped += 1;
      }
    }
    childResult = { updated, skipped };
    childSyncing = false;
    childConfirm = false;
  }

  function levelLabel(level: number): string {
    const tag = tagForLevel(roleTags, level);
    if (tag) return tag.name;
    const known = namedLevels.find((entry) => entry.level === level);
    return known ? $i18n.t(known.label) : String(level);
  }

  function options(current: number): { value: string; label: string; disabled?: boolean }[] {
    const named = namedLevels.map((entry) => ({
      value: String(entry.level),
      label: levelLabel(entry.level),
      disabled: entry.level > ownLevel,
    }));
    const custom = Object.entries(roleTags)
      .map(([key, tag]) => ({ level: Number(key), tag }))
      .filter(({ level }) => !named.some((entry) => entry.value === String(level)))
      .sort((a, b) => b.level - a.level)
      .map(({ level, tag }) => ({
        value: String(level),
        label: tag.name,
        disabled: level > ownLevel,
      }));
    const known = [...named, ...custom];
    if (known.some((option) => option.value === String(current))) return known;
    return [{ value: String(current), label: String(current) }, ...known];
  }

  function locationKey(location: PermissionLocation): string {
    return JSON.stringify(location);
  }

  function withoutKey(record: Record<string, string>, key: string): Record<string, string> {
    return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
  }

  async function commitNumber(
    location: PermissionLocation,
    key: string,
    raw: string
  ): Promise<void> {
    const result = parsePowerLevelInput(raw, ownLevel);
    if (!result.valid) {
      const messages = {
        'not-a-number': $i18n.t('room.permLevelNumberInvalid'),
        'out-of-range': $i18n.t('room.permLevelNumberOutOfRange'),
        'exceeds-own': $i18n.t('room.permLevelNumberExceedsOwn'),
      } as const;
      numberErrors = { ...numberErrors, [key]: messages[result.reason] };
      return;
    }

    numberDrafts = withoutKey(numberDrafts, key);
    numberErrors = withoutKey(numberErrors, key);
    await setLevel(location, result.level);
  }

  function startEditRole(level: number): void {
    const tag = tagForLevel(roleTags, level);
    editingLevel = level;
    editingNewRole = false;
    roleLevelDraft = String(level);
    roleNameDraft = tag?.name ?? levelLabel(level);
    roleColorDraft = tag?.color ?? '';
    roleIconDraft = tag?.icon ?? '';
    roleLevelError = null;
    roleFailed = false;
  }

  function startAddRole(): void {
    editingLevel = null;
    editingNewRole = true;
    roleLevelDraft = '';
    roleNameDraft = '';
    roleColorDraft = '';
    roleIconDraft = '';
    roleLevelError = null;
    roleFailed = false;
  }

  function revealRoleEditor(node: HTMLElement): void {
    void editingLevel;
    node.scrollIntoView({ block: 'nearest' });
    node.querySelector('input')?.focus({ preventScroll: true });
  }

  function cancelEditRole(): void {
    editingLevel = null;
    editingNewRole = false;
  }

  async function saveRole(): Promise<void> {
    const target = roomId;
    if (!target || !editingRole || roleSaving) return;

    let level: number;
    if (editingNewRole) {
      const levelInput = parsePowerLevelInput(roleLevelDraft, ownLevel);
      if (!levelInput.valid) {
        const messages = {
          'not-a-number': $i18n.t('room.permLevelNumberInvalid'),
          'out-of-range': $i18n.t('room.permLevelNumberOutOfRange'),
          'exceeds-own': $i18n.t('room.permLevelNumberExceedsOwn'),
        } as const;
        roleLevelError = messages[levelInput.reason];
        return;
      }
      level = levelInput.level;
    } else {
      if (editingLevel === null) return;
      level = editingLevel;
    }

    const name = roleNameDraft.trim();
    if (name === '') return;

    const color = /^#[0-9a-f]{6}$/i.test(roleColorDraft.trim()) ? roleColorDraft.trim() : null;

    roleSaving = true;
    roleFailed = false;
    try {
      const nextContent = withPowerLevelTag(rawRoleTags, level, {
        name,
        color,
        icon: roleIconDraft.trim() || null,
      });
      await core.commands.sendStateEvent(target, POWER_LEVEL_TAGS_EVENT_TYPE, '', nextContent);
      rawRoleTags = nextContent;
      editingLevel = null;
      editingNewRole = false;
    } catch (error) {
      console.warn('[sable room] role tag save failed', error);
      roleFailed = true;
    } finally {
      roleSaving = false;
    }
  }

  async function removeRole(): Promise<void> {
    const target = roomId;
    const level = editingLevel;
    if (!target || level === null || roleSaving) return;

    roleSaving = true;
    roleFailed = false;
    try {
      const nextContent = withPowerLevelTag(rawRoleTags, level, null);
      await core.commands.sendStateEvent(target, POWER_LEVEL_TAGS_EVENT_TYPE, '', nextContent);
      rawRoleTags = nextContent;
      editingLevel = null;
    } catch (error) {
      console.warn('[sable room] role tag remove failed', error);
      roleFailed = true;
    } finally {
      roleSaving = false;
    }
  }

  async function uploadRoleIcon(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || iconUploading) return;

    iconUploading = true;
    roleFailed = false;
    try {
      const upright = await uprightJpeg(file);
      const bytes = new Uint8Array(await upright.arrayBuffer());
      roleIconDraft = await core.commands.uploadMedia(upright.type || 'image/*', bytes);
    } catch (error) {
      console.warn('[sable room] role icon upload failed', error);
      roleFailed = true;
    } finally {
      iconUploading = false;
    }
  }

  async function confirmRemoveRole(): Promise<void> {
    await removeRole();
    roleRemoveConfirm = false;
  }
</script>

<div class="section">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.permFailed')}</Alert>
  {/if}

  {#if loading && levels === null}
    <p class="settings-status" role="status"><Spinner small /></p>
  {:else if levels}
    {#if founders.length > 0}
      <SettingsSection
        headingId="room-perm-founders"
        title={$i18n.t('room.permFounders')}
        description={$i18n.t('room.permFoundersHint')}
      >
        <ul class="settings-rows">
          {#each founders as founder (founder)}
            <SettingsRow>
              {#snippet copy()}
                <MemberIdentityRow userId={founder} members={[]}>
                  {#snippet trailing()}
                    <span class="level">{founder}</span>
                  {/snippet}
                </MemberIdentityRow>
              {/snippet}
            </SettingsRow>
          {/each}
        </ul>
      </SettingsSection>
    {/if}

    <SettingsSection headingId="room-perm-roles" title={$i18n.t('room.permRoles')}>
      <ul class="settings-rows">
        {#each roleLevels as level (level)}
          {@const tag = tagForLevel(roleTags, level)}
          <SettingsRow title={`${levelLabel(level)} (${level})`}>
            {#if tag?.icon}<RoleTagIcon icon={tag.icon} class="role-icon" />{/if}
            <span class="role-swatch" style:background-color={tag?.color ?? undefined}></span>
            <IconButton
              variant="subtle"
              size="small"
              label={$i18n.t('room.permRolePeek', { role: levelLabel(level) })}
              aria-expanded={peekLevel === level}
              onclick={() => {
                peekLevel = peekLevel === level ? null : level;
              }}
            >
              <ListChecksIcon />
            </IconButton>
            {#if canEdit && level <= ownLevel}
              <IconButton
                variant="subtle"
                size="small"
                label={$i18n.t('room.permRoleEdit')}
                disabled={saving}
                onclick={() => startEditRole(level)}
              >
                <PencilIcon />
              </IconButton>
            {/if}
          </SettingsRow>
          {#if peekLevel === level}
            <li class="settings-form peek">
              {#each groups as group (group.label)}
                <div class="peek-group">
                  <p class="peek-title">{$i18n.t(group.label)}</p>
                  <ul class="peek-items">
                    {#each group.items as item (item.label)}
                      {@const allowed = levelAt(levels, item.location) <= level}
                      <li class:denied={!allowed}>
                        {#if allowed}<CheckIcon aria-hidden="true" />{:else}<XIcon
                            aria-hidden="true"
                          />{/if}
                        <span>{$i18n.t(item.label)}</span>
                        <span class="screen-reader-only">
                          {allowed ? $i18n.t('room.permAllowed') : $i18n.t('room.permDenied')}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/each}
            </li>
          {/if}
        {/each}
        {#if canEdit}
          <li class="settings-row role-add-row">
            <Button variant="secondary" onclick={startAddRole} disabled={saving}>
              {$i18n.t('room.permRoleAdd')}
            </Button>
          </li>
        {/if}
      </ul>
    </SettingsSection>

    {#if canEdit && syncSpaceId}
      <SettingsSection headingId="room-perm-sync" title={$i18n.t('room.permSyncTitle')}>
        <ul class="settings-rows">
          <SettingsRow
            title={$i18n.t('room.permSyncRow', { space: spaceName(syncSpaceId) })}
            description={$i18n.t('room.permSyncHint')}
          >
            {#if syncSpaceIds.length > 1}
              <Select
                value={syncSpaceId}
                aria-label={$i18n.t('room.permSyncSpace')}
                disabled={syncing}
                items={syncSpaceIds.map((spaceId) => ({
                  value: spaceId,
                  label: spaceName(spaceId),
                }))}
                onValueChange={(next: string) => {
                  syncChoice = next;
                }}
              />
            {/if}
            <Button
              variant="secondary"
              disabled={saving || syncing}
              onclick={() => {
                syncFailed = false;
                syncConfirm = true;
              }}
            >
              {$i18n.t('room.permSync')}
            </Button>
          </SettingsRow>
        </ul>
      </SettingsSection>
    {/if}

    {#if canEdit && childIds.length > 0}
      <SettingsSection headingId="room-perm-children" title={$i18n.t('room.permChildrenTitle')}>
        <ul class="settings-rows">
          <SettingsRow
            title={$i18n.t('room.permChildrenRow', { count: childIds.length })}
            description={childResult
              ? $i18n.t('room.permChildrenDone', {
                  count: childResult.updated,
                  skipped: childResult.skipped,
                })
              : $i18n.t('room.permChildrenHint')}
          >
            <Button
              variant="secondary"
              disabled={saving || childSyncing}
              onclick={() => {
                childResult = null;
                childConfirm = true;
              }}
            >
              {$i18n.t('room.permChildrenApply')}
            </Button>
          </SettingsRow>
        </ul>
      </SettingsSection>
    {/if}

    {#each groups as group (group.label)}
      <SettingsSection headingId={`room-perm-${group.label}`} title={$i18n.t(group.label)}>
        <ul class="settings-rows">
          {#each group.items as item (item.label)}
            {@const level = levelAt(levels, item.location)}
            {@const tag = tagForLevel(roleTags, level)}
            {@const key = locationKey(item.location)}
            {@const numberErrorId = `room-perm-number-error-${item.label.replace(/\./g, '-')}`}
            <SettingsRow title={$i18n.t(item.label)}>
              {#if tag}
                <span class="role-chip">
                  <span
                    class="role-swatch"
                    style:background-color={tag.color ?? undefined}
                    aria-hidden="true"
                  ></span>
                  {#if tag.icon}<RoleTagIcon icon={tag.icon} class="role-icon" />{/if}
                  <span class="role-name">{tag.name} ({level})</span>
                </span>
              {:else}
                <span class="level">{levelLabel(level)}</span>
              {/if}
              {#if canEdit && level <= ownLevel}
                <IconButton
                  variant="subtle"
                  size="small"
                  label={$i18n.t('room.permRoleEdit')}
                  disabled={saving}
                  onclick={() => startEditRole(level)}
                >
                  <PencilIcon />
                </IconButton>
                <Select
                  value={String(level)}
                  aria-label={$i18n.t(item.label)}
                  disabled={saving}
                  items={options(level)}
                  onValueChange={(next: string) => {
                    void setLevel(item.location, Number(next));
                  }}
                />
                <div class="number-field">
                  <TextInput
                    inputmode="numeric"
                    aria-label={$i18n.t('room.permLevelCustomLabel', {
                      permission: $i18n.t(item.label),
                    })}
                    aria-invalid={numberErrors[key] ? 'true' : undefined}
                    aria-describedby={numberErrors[key] ? numberErrorId : undefined}
                    disabled={saving}
                    bind:value={
                      () => numberDrafts[key] ?? String(level),
                      (value) => {
                        numberDrafts = { ...numberDrafts, [key]: value };
                      }
                    }
                    onchange={(event: Event) => {
                      void commitNumber(
                        item.location,
                        key,
                        (event.currentTarget as HTMLInputElement).value
                      );
                    }}
                  />
                  {#if numberErrors[key]}
                    <p id={numberErrorId} class="number-error" role="alert">
                      {numberErrors[key]}
                    </p>
                  {/if}
                </div>
              {/if}
            </SettingsRow>
          {/each}
        </ul>
      </SettingsSection>
    {/each}

    {#if editingRole}
      <SettingsSection headingId="room-perm-role-editor" title={$i18n.t('room.permRoleEdit')}>
        <form
          class="settings-form"
          {@attach revealRoleEditor}
          onsubmit={(event) => {
            event.preventDefault();
            void saveRole();
          }}
        >
          {#if roleFailed}
            <Alert variant="critical" role="alert">{$i18n.t('room.permFailed')}</Alert>
          {/if}
          {#if editingNewRole}
            <FormField fieldId="room-perm-role-level" label={$i18n.t('room.permRoleLevel')}>
              <TextInput
                id="room-perm-role-level"
                inputmode="numeric"
                aria-invalid={roleLevelError ? 'true' : undefined}
                bind:value={roleLevelDraft}
                required
              />
              {#if roleLevelError}<p class="number-error" role="alert">{roleLevelError}</p>{/if}
            </FormField>
          {/if}
          <FormField fieldId="room-perm-role-name" label={$i18n.t('room.permRoleName')}>
            <TextInput id="room-perm-role-name" bind:value={roleNameDraft} required />
          </FormField>
          <FormField fieldId="room-perm-role-color" label={$i18n.t('room.permRoleColor')}>
            <TextInput
              id="room-perm-role-color"
              bind:value={roleColorDraft}
              placeholder={$i18n.t('room.permRoleColorHint')}
            />
          </FormField>
          <FormField fieldId="room-perm-role-icon" label={$i18n.t('room.permRoleIcon')}>
            <div class="icon-field">
              <span class="icon-preview" aria-hidden="true">
                {#if roleIconDraft}<RoleTagIcon icon={roleIconDraft} />{/if}
              </span>
              <TextInput
                id="room-perm-role-icon"
                class="icon-text"
                bind:value={roleIconDraft}
                placeholder="✨"
                autocomplete="off"
              />
              <ReactionPicker
                label={$i18n.t('room.permRoleIconPick')}
                roomId={roomId ?? ''}
                triggerClass="btn btn-secondary btn-small"
                onPick={(key: string) => {
                  roleIconDraft = key;
                }}
              >
                {$i18n.t('room.permRoleIconPick')}
              </ReactionPicker>
              <Button
                type="button"
                size="small"
                variant="secondary"
                loading={iconUploading}
                onclick={() => iconInput?.click()}
              >
                {$i18n.t('room.permRoleIconUpload')}
              </Button>
              {#if roleIconDraft}
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  onclick={() => {
                    roleIconDraft = '';
                  }}
                >
                  {$i18n.t('room.permRoleIconClear')}
                </Button>
              {/if}
              <input
                bind:this={iconInput}
                class="icon-input"
                type="file"
                accept="image/*"
                tabindex="-1"
                aria-hidden="true"
                onchange={uploadRoleIcon}
              />
            </div>
          </FormField>
          <div class="actions">
            {#if editingHasTag}
              <Button
                type="button"
                variant="danger"
                onclick={() => {
                  roleRemoveConfirm = true;
                }}
                disabled={roleSaving}
              >
                {$i18n.t('room.permRoleRemove')}
              </Button>
            {/if}
            <Button type="button" variant="ghost" onclick={cancelEditRole} disabled={roleSaving}>
              {$i18n.t('room.permRoleCancel')}
            </Button>
            <Button type="submit" loading={roleSaving} disabled={roleNameDraft.trim() === ''}>
              {$i18n.t('room.permRoleSave')}
            </Button>
          </div>
        </form>
      </SettingsSection>
    {/if}
  {/if}
</div>

<ConfirmDialog
  bind:open={syncConfirm}
  title={$i18n.t('room.permSyncConfirm', { space: syncSpaceId ? spaceName(syncSpaceId) : '' })}
  description={$i18n.t('room.permSyncConfirmHint')}
  confirmLabel={$i18n.t('room.permSync')}
  busy={syncing}
  error={syncFailed ? $i18n.t('room.permFailed') : null}
  onConfirm={() => void syncFromSpace()}
/>

<ConfirmDialog
  bind:open={childConfirm}
  title={$i18n.t('room.permChildrenConfirm', { count: childIds.length })}
  description={$i18n.t('room.permSyncConfirmHint')}
  confirmLabel={$i18n.t('room.permChildrenApply')}
  busy={childSyncing}
  onConfirm={() => void syncChildren()}
/>

<ConfirmDialog
  bind:open={roleRemoveConfirm}
  title={$i18n.t('room.permRoleRemoveConfirm')}
  description={$i18n.t('room.permRoleRemoveHint')}
  confirmLabel={$i18n.t('room.permRoleRemove')}
  busy={roleSaving}
  onConfirm={() => void confirmRemoveRole()}
/>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }

  .level {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .role-chip {
    align-items: center;
    background-color: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-pill);
    display: inline-flex;
    gap: var(--space-200);
    padding: var(--space-100) var(--space-300);
  }

  .role-swatch {
    background-color: var(--surface-var-on-container);
    border-radius: var(--radius-pill);
    flex: 0 0 auto;
    height: 0.6rem;
    width: 0.6rem;
  }

  .role-add-row {
    justify-content: flex-end;
  }

  .role-name {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  :global(.role-icon) {
    font-size: var(--font-size-small);
  }

  .peek {
    gap: var(--space-300);
  }

  .peek-group {
    display: grid;
    gap: var(--space-100);
  }

  .peek-title {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .peek-items {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .peek-items li {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
  }

  .peek-items li :global(svg) {
    color: var(--success-main);
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .peek-items li.denied {
    color: var(--surface-var-on-container);
  }

  .peek-items li.denied :global(svg) {
    color: var(--crit-main);
  }

  .icon-field {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .icon-field :global(.icon-text) {
    flex: 1 1 8rem;
    min-width: 0;
  }

  .icon-preview {
    align-items: center;
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    display: inline-flex;
    font-size: var(--font-size-heading);
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .icon-input {
    height: 0;
    opacity: 0;
    position: absolute;
    width: 0;
  }

  .number-field {
    display: grid;
    gap: var(--space-100);
    width: 6rem;
  }

  .number-error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
