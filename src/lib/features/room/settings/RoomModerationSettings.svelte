<script lang="ts">
  import type {
    RoomListItemView,
    RoomPermissionsView,
    RoomPowerLevelsView,
  } from '#src/generated/protocol';
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
  import SlidersIcon from 'phosphor-svelte/lib/SlidersHorizontalIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { loadMeowlnirConfig, updateMeowlnirEvent } from '#lib/rooms/meowlnir.svelte.js';
  import { rememberMeowlnirRoom } from '#lib/rooms/meowlnir-registry.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import {
    LIST_FLAGS,
    PROTECTED_ROOMS_EVENT,
    PROTECTIONS,
    WATCHED_LISTS_EVENT,
    addProtectedRoom,
    addWatchedList,
    isRoomId,
    moveWatchedList,
    patternLines,
    protectedRooms,
    protectionConfig,
    removeProtectedRoom,
    removeWatchedList,
    setProtectionEnabled,
    setProtectionField,
    setSkipAcl,
    setWatchedListFlag,
    unknownProtections,
    watchedLists,
    type ListFlag,
    type RawContent,
    type WatchedList,
  } from '#lib/rooms/meowlnir-config.js';
  import ModerationListRules from './ModerationListRules.svelte';
  import { canSendState } from './permission-groups';

  import '#lib/ui/primitives/settings-row.css';

  const OTHER = 'other';
  /** Stored as opt-outs, shown as what Meowlnir does when the switch is on. */
  const OPT_OUT_FLAGS: ReadonlySet<ListFlag> = new Set([
    'dont_apply',
    'dont_apply_acl',
    'dont_notify_on_change',
  ]);

  interface Props {
    room: RoomListItemView | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  }

  type ConfigEvent = typeof PROTECTED_ROOMS_EVENT | typeof WATCHED_LISTS_EVENT;
  type Removal = { kind: 'room' | 'list'; roomId: string; name: string };

  let { room, permissions, levels }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  let roomId = $derived(room?.room_id ?? null);
  let config = $derived(
    roomId === null
      ? null
      : await loadMeowlnirConfig(core, roomId).catch((error: unknown) => {
          console.warn('[sable room] meowlnir settings unavailable', error);
          return null;
        })
  );
  let canEdit = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, WATCHED_LISTS_EVENT)
  );

  $effect(() => {
    const userId = core.session?.user_id;
    if (roomId && userId && config && canEdit) rememberMeowlnirRoom(roomId, userId, config);
  });

  let rooms = $derived(protectedRooms(config?.protectedRooms ?? null));
  let lists = $derived(watchedLists(config?.watchedLists ?? null));
  let strangers = $derived(unknownProtections(config?.protectedRooms ?? null));

  let roomDraft = $state({ choice: '', id: '' });
  let listDraft = $state({ choice: '', id: '', shortcode: '' });
  let openList = $state<string | null>(null);
  let pendingRemoval = $state<Removal | null>(null);
  let saves = Promise.resolve();

  let joinedRooms = $derived(
    roomList.rooms.filter(
      (candidate) =>
        candidate.state === 'joined' &&
        candidate.room_kind !== 'space' &&
        !candidate.is_direct &&
        candidate.room_id !== roomId
    )
  );

  function choices(taken: readonly string[]): { value: string; label: string }[] {
    return [
      ...joinedRooms
        .filter((candidate) => !taken.includes(candidate.room_id))
        .map((candidate) => ({ value: candidate.room_id, label: candidate.display_name })),
      { value: OTHER, label: i18n.t('room.moderationOtherRoom') },
    ];
  }

  function chosen(draft: { choice: string; id: string }): string | null {
    const id = draft.choice === OTHER ? draft.id.trim() : draft.choice;
    return isRoomId(id) ? id : null;
  }

  function nameOf(id: string): string {
    return roomList.byId(id)?.display_name ?? id;
  }

  function listName(list: WatchedList): string {
    return list.name ?? roomList.byId(list.roomId)?.display_name ?? list.shortcode ?? list.roomId;
  }

  /** Shown at once, then settled on what the server accepted. Saves run one at a time. */
  function save(eventType: ConfigEvent, change: (content: RawContent) => RawContent): void {
    const target = roomId;
    if (!target || !config) return;
    const key = eventType === PROTECTED_ROOMS_EVENT ? 'protectedRooms' : 'watchedLists';
    config = { ...config, [key]: change(config[key] ?? {}) };
    saves = saves.then(async () => {
      try {
        const saved = await updateMeowlnirEvent(core, target, eventType, change);
        if (roomId === target && config) config = { ...config, [key]: saved };
      } catch (error) {
        console.warn('[sable room] meowlnir settings save failed', error);
        toasts.error(i18n.t('errors.actionFailed'));
        if (roomId !== target) return;
        config = await loadMeowlnirConfig(core, target).catch(() => config);
      }
    });
  }

  function protect(event: SubmitEvent): void {
    event.preventDefault();
    const id = chosen(roomDraft);
    if (!id) return;
    save(PROTECTED_ROOMS_EVENT, (content) => addProtectedRoom(content, id));
    roomDraft = { choice: '', id: '' };
  }

  function watch(event: SubmitEvent): void {
    event.preventDefault();
    const id = chosen(listDraft);
    const shortcode = listDraft.shortcode.trim();
    if (!id || shortcode === '') return;
    save(WATCHED_LISTS_EVENT, (content) => addWatchedList(content, id, shortcode));
    listDraft = { choice: '', id: '', shortcode: '' };
  }

  function confirmRemoval(): void {
    const removal = pendingRemoval;
    pendingRemoval = null;
    if (!removal) return;
    if (removal.kind === 'room')
      save(PROTECTED_ROOMS_EVENT, (content) => removeProtectedRoom(content, removal.roomId));
    else save(WATCHED_LISTS_EVENT, (content) => removeWatchedList(content, removal.roomId));
  }

  function setNumber(name: string, key: string, typed: string): void {
    const value = Number(typed);
    if (typed.trim() === '' || !Number.isInteger(value) || value < 0) return;
    save(PROTECTED_ROOMS_EVENT, (content) => setProtectionField(content, name, key, value));
  }
</script>

{#snippet roomChooser(
  draft: { choice: string; id: string },
  taken: readonly string[],
  fieldId: string
)}
  <FormField {fieldId} label={i18n.t('room.moderationRoom')}>
    <Select
      id={fieldId}
      bind:value={draft.choice}
      items={choices(taken)}
      placeholder={i18n.t('room.moderationRoomPlaceholder')}
      forceDropdown
    />
  </FormField>
  {#if draft.choice === OTHER}
    <FormField fieldId="{fieldId}-id" label={i18n.t('room.moderationRoomId')}>
      <TextInput
        id="{fieldId}-id"
        bind:value={draft.id}
        placeholder="!abcdef:example.org"
        autocapitalize="off"
        autocomplete="off"
        spellcheck={false}
      />
    </FormField>
  {/if}
{/snippet}

<div class="section">
  {#if config === null}
    <Alert variant="critical" role="alert">{i18n.t('room.moderationUnavailable')}</Alert>
  {:else}
    <p class="settings-note">
      {i18n.t(canEdit ? 'room.moderationHint' : 'room.moderationReadOnly')}
    </p>

    <SettingsSection
      headingId="room-settings-moderation-rooms"
      title={i18n.t('room.moderationRooms')}
      description={i18n.t('room.moderationRoomsHint')}
    >
      {#if rooms.length > 0}
        <ul class="settings-rows">
          {#each rooms as entry (entry.roomId)}
            {@const name = nameOf(entry.roomId)}
            {@const known = roomList.byId(entry.roomId)}
            <SettingsRow
              title={name}
              description={known ? undefined : i18n.t('room.moderationRoomUnknown')}
            >
              {#snippet before()}
                <Avatar
                  id={entry.roomId}
                  src={known?.display_avatar_url ?? null}
                  {name}
                  size="small"
                  decorative
                />
              {/snippet}
              <span class="switch-label" aria-hidden="true">
                {i18n.t('room.moderationServerBans')}
              </span>
              <Switch
                checked={!entry.skipAcl}
                disabled={!canEdit}
                label={i18n.t('room.moderationServerBansIn', { name })}
                onCheckedChange={(checked) => {
                  save(PROTECTED_ROOMS_EVENT, (content) =>
                    setSkipAcl(content, entry.roomId, !checked)
                  );
                }}
              />
              {#if canEdit}
                <IconButton
                  variant="subtle"
                  size="small"
                  label={i18n.t('room.moderationUnprotect', { name })}
                  onclick={() => {
                    pendingRemoval = { kind: 'room', roomId: entry.roomId, name };
                  }}
                >
                  <TrashIcon />
                </IconButton>
              {/if}
            </SettingsRow>
          {/each}
        </ul>
      {:else}
        <p class="settings-note settings-form">{i18n.t('room.moderationRoomsEmpty')}</p>
      {/if}
      {#if canEdit}
        <form class="settings-form add" onsubmit={protect}>
          {@render roomChooser(
            roomDraft,
            rooms.map((entry) => entry.roomId),
            'room-moderation-protect'
          )}
          <div class="actions">
            <Button type="submit" disabled={chosen(roomDraft) === null}>
              {i18n.t('room.moderationProtect')}
            </Button>
          </div>
        </form>
      {/if}
    </SettingsSection>

    <SettingsSection
      headingId="room-settings-moderation-lists"
      title={i18n.t('room.moderationLists')}
      description={i18n.t('room.moderationListsHint')}
    >
      {#if lists.length > 0}
        <ul class="settings-rows">
          {#each lists as list, index (list.roomId)}
            {@const name = listName(list)}
            <SettingsRow
              title={name}
              description={list.dont_apply ? i18n.t('room.moderationListPaused') : undefined}
              badge={list.shortcode !== null && list.shortcode !== name
                ? list.shortcode
                : undefined}
            >
              <IconButton
                variant="subtle"
                size="small"
                label={i18n.t('room.moderationListOptions', { name })}
                aria-expanded={openList === list.roomId}
                onclick={() => {
                  openList = openList === list.roomId ? null : list.roomId;
                }}
              >
                <SlidersIcon />
              </IconButton>
              {#if canEdit}
                <IconButton
                  variant="subtle"
                  size="small"
                  disabled={index === 0}
                  label={i18n.t('room.moderationListUp', { name })}
                  onclick={() => {
                    save(WATCHED_LISTS_EVENT, (content) =>
                      moveWatchedList(content, list.roomId, -1)
                    );
                  }}
                >
                  <ArrowUpIcon />
                </IconButton>
                <IconButton
                  variant="subtle"
                  size="small"
                  disabled={index === lists.length - 1}
                  label={i18n.t('room.moderationListDown', { name })}
                  onclick={() => {
                    save(WATCHED_LISTS_EVENT, (content) =>
                      moveWatchedList(content, list.roomId, 1)
                    );
                  }}
                >
                  <ArrowDownIcon />
                </IconButton>
                <IconButton
                  variant="subtle"
                  size="small"
                  label={i18n.t('room.moderationUnwatch', { name })}
                  onclick={() => {
                    pendingRemoval = { kind: 'list', roomId: list.roomId, name };
                  }}
                >
                  <TrashIcon />
                </IconButton>
              {/if}
            </SettingsRow>
            {#if openList === list.roomId}
              {#each LIST_FLAGS as flag (flag)}
                {@const optOut = OPT_OUT_FLAGS.has(flag)}
                <SettingsRow
                  class="nested"
                  title={i18n.t(`room.moderationFlag.${flag}`)}
                  description={i18n.t(`room.moderationFlagHint.${flag}`)}
                >
                  <Switch
                    checked={list[flag] !== optOut}
                    disabled={!canEdit}
                    label={i18n.t(`room.moderationFlag.${flag}`)}
                    onCheckedChange={(checked) => {
                      save(WATCHED_LISTS_EVENT, (content) =>
                        setWatchedListFlag(content, list.roomId, flag, checked !== optOut)
                      );
                    }}
                  />
                </SettingsRow>
              {/each}
              {#if roomId}
                <ModerationListRules
                  managementRoomId={roomId}
                  listRoomId={list.roomId}
                  {name}
                  shortcode={list.shortcode}
                  {canEdit}
                />
              {/if}
            {/if}
          {/each}
        </ul>
      {:else}
        <p class="settings-note settings-form">{i18n.t('room.moderationListsEmpty')}</p>
      {/if}
      {#if canEdit}
        <form class="settings-form add" onsubmit={watch}>
          {@render roomChooser(
            listDraft,
            lists.map((list) => list.roomId),
            'room-moderation-watch'
          )}
          <FormField fieldId="room-moderation-shortcode" label={i18n.t('room.moderationShortcode')}>
            <TextInput
              id="room-moderation-shortcode"
              bind:value={listDraft.shortcode}
              placeholder={i18n.t('room.moderationShortcodePlaceholder')}
              autocapitalize="off"
              autocomplete="off"
              spellcheck={false}
            />
          </FormField>
          <div class="actions">
            <Button
              type="submit"
              disabled={chosen(listDraft) === null || listDraft.shortcode.trim() === ''}
            >
              {i18n.t('room.moderationWatch')}
            </Button>
          </div>
        </form>
      {/if}
    </SettingsSection>

    <SettingsSection
      headingId="room-settings-moderation-protections"
      title={i18n.t('room.moderationProtections')}
      description={i18n.t('room.moderationProtectionsHint')}
    >
      <ul class="settings-rows">
        {#each PROTECTIONS as protection (protection.name)}
          {@const settings = protectionConfig(config.protectedRooms, protection.name)}
          {@const title = i18n.t(`room.moderationProtection.${protection.name}`)}
          <SettingsRow
            {title}
            description={i18n.t(`room.moderationProtectionHint.${protection.name}`)}
            badge={protection.experimental ? i18n.t('room.moderationExperimental') : undefined}
          >
            <Switch
              checked={settings !== null}
              disabled={!canEdit}
              label={title}
              onCheckedChange={(checked) => {
                save(PROTECTED_ROOMS_EVENT, (content) =>
                  setProtectionEnabled(content, protection.name, checked)
                );
              }}
            />
          </SettingsRow>
          {#if settings !== null}
            {#each protection.fields as field (field.key)}
              {@const label = i18n.t(`room.moderationField.${field.key}`)}
              {@const fieldId = `room-moderation-${protection.name}-${field.key}`}
              {#if field.kind === 'switch'}
                <SettingsRow class="nested" title={label}>
                  <Switch
                    checked={settings[field.key] === true}
                    disabled={!canEdit}
                    label={`${title}: ${label}`}
                    onCheckedChange={(checked) => {
                      save(PROTECTED_ROOMS_EVENT, (content) =>
                        setProtectionField(content, protection.name, field.key, checked)
                      );
                    }}
                  />
                </SettingsRow>
              {:else if field.kind === 'number'}
                <SettingsRow class="nested" title={label} control={fieldId}>
                  <TextInput
                    id={fieldId}
                    class="number"
                    type="number"
                    inputmode="numeric"
                    min="0"
                    step="1"
                    disabled={!canEdit}
                    value={typeof settings[field.key] === 'number'
                      ? String(settings[field.key])
                      : ''}
                    onchange={(event) => {
                      setNumber(protection.name, field.key, event.currentTarget.value);
                    }}
                  />
                </SettingsRow>
              {:else}
                <SettingsRow
                  class="nested"
                  title={label}
                  description={i18n.t('room.moderationPatternsHint')}
                  control={fieldId}
                  wide
                >
                  <TextArea
                    id={fieldId}
                    class="patterns"
                    rows={3}
                    disabled={!canEdit}
                    spellcheck={false}
                    value={patternLines(
                      Array.isArray(settings[field.key])
                        ? (settings[field.key] as unknown[]).join('\n')
                        : ''
                    ).join('\n')}
                    onchange={(event) => {
                      const patterns = patternLines(event.currentTarget.value);
                      save(PROTECTED_ROOMS_EVENT, (content) =>
                        setProtectionField(content, protection.name, field.key, patterns)
                      );
                    }}
                  />
                </SettingsRow>
              {/if}
            {/each}
          {/if}
        {/each}
        {#each strangers as name (name)}
          <SettingsRow title={name} description={i18n.t('room.moderationProtectionUnknown')} />
        {/each}
      </ul>
    </SettingsSection>
  {/if}
</div>

<ConfirmDialog
  open={pendingRemoval !== null}
  onOpenChange={(next: boolean) => {
    if (!next) pendingRemoval = null;
  }}
  title={i18n.t(
    pendingRemoval?.kind === 'list'
      ? 'room.moderationUnwatchConfirm'
      : 'room.moderationUnprotectConfirm',
    { name: pendingRemoval?.name ?? '' }
  )}
  description={i18n.t(
    pendingRemoval?.kind === 'list'
      ? 'room.moderationUnwatchConfirmHint'
      : 'room.moderationUnprotectConfirmHint'
  )}
  confirmLabel={i18n.t('common.remove')}
  onConfirm={confirmRemoval}
/>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }

  .section :global(.setting-row.nested) {
    padding-inline-start: var(--space-700);
  }

  .section :global(.number) {
    font-variant-numeric: tabular-nums;
    width: calc(2 * var(--space-900));
  }

  .section :global(.patterns) {
    flex: 1 1 calc(4 * var(--space-900));
  }

  .add {
    box-shadow: inset 0 var(--border-width) 0 var(--bg-container-line);
    padding-block-start: var(--space-400);
  }

  .switch-label {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
