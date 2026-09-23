<script lang="ts">
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';
  import PencilIcon from 'phosphor-svelte/lib/PencilIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { abbreviationsChanged, abbreviationChanges } from '../room-abbreviations.svelte.js';
  import { ancestorSpaceIds } from '../abbreviations.js';
  import { canSendState } from './permission-groups';
  import {
    ABBREVIATIONS_EVENT_TYPE,
    abbreviationKey,
    readAbbreviations,
    upsertAbbreviation,
    type AbbreviationEntry,
  } from './abbreviations';

  import '#lib/ui/primitives/settings-row.css';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  }

  let { room, permissions, levels }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  type InheritedGroup = { spaceId: string; spaceName: string; entries: AbbreviationEntry[] };

  let entries = $state.raw<AbbreviationEntry[]>([]);
  let inheritedGroups = $state.raw<InheritedGroup[]>([]);
  let term = $state('');
  let definition = $state('');
  let cased = $state(false);
  let editingKey = $state<string | null>(null);
  let duplicate = $state(false);
  let pendingRemoval = $state<AbbreviationEntry | null>(null);
  let busy = $state(false);
  let failed = $state(false);
  let run = 0;
  let inheritedRun = 0;

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, ABBREVIATIONS_EVENT_TYPE)
  );
  let inheritedEntries = $derived(inheritedGroups.flatMap((group) => group.entries));
  let totalCount = $derived(entries.length + inheritedEntries.length);

  $effect(() => {
    const target = roomId;
    resetForm();
    if (!target) return;

    const current = ++run;
    void core.commands
      .roomStateEvent(target, ABBREVIATIONS_EVENT_TYPE)
      .then((content) => {
        if (current === run) entries = readAbbreviations(content);
      })
      .catch((error: unknown) => {
        console.debug('[sable room] abbreviations unavailable', error);
      });
  });

  // Abbreviations inherited from parent spaces are read-only here, like v1:
  // they are defined in the space and apply to every room inside it.
  $effect(() => {
    const target = roomId;
    void roomList.rooms;
    void abbreviationChanges.version;
    if (!target || room?.is_space) {
      inheritedGroups = [];
      return;
    }

    const ids = ancestorSpaceIds(roomList.rooms, target);
    const current = ++inheritedRun;
    void Promise.all(
      ids.map(async (spaceId) => {
        let list: AbbreviationEntry[] = [];
        try {
          list = readAbbreviations(
            await core.commands.roomStateEvent(spaceId, ABBREVIATIONS_EVENT_TYPE)
          );
        } catch (error) {
          console.debug('[sable room] inherited abbreviations unavailable', error);
        }
        const space = roomList.byId(spaceId);
        return { spaceId, spaceName: space?.name ?? spaceId, entries: list };
      })
    ).then((groups) => {
      if (current !== inheritedRun) return;
      inheritedGroups = groups.filter((group) => group.entries.length > 0);
    });
  });

  $effect(() => {
    void term;
    void definition;
    duplicate = false;
  });

  async function save(next: readonly AbbreviationEntry[]): Promise<boolean> {
    const target = roomId;
    if (!target || busy) return false;

    busy = true;
    failed = false;
    try {
      await core.commands.sendStateEvent(target, ABBREVIATIONS_EVENT_TYPE, '', { entries: next });
      entries = [...next];
      abbreviationsChanged();
      return true;
    } catch (error) {
      console.warn('[sable room] abbreviation save failed', error);
      failed = true;
      return false;
    } finally {
      busy = false;
    }
  }

  function resetForm(): void {
    term = '';
    definition = '';
    cased = false;
    editingKey = null;
    duplicate = false;
    failed = false;
  }

  function isEditing(entry: AbbreviationEntry): boolean {
    return editingKey !== null && editingKey === abbreviationKey(entry);
  }

  function draft(): AbbreviationEntry | null {
    const nextTerm = term.trim();
    const nextDefinition = definition.trim();
    if (nextTerm === '' || nextDefinition === '') return null;
    return { term: nextTerm, definition: nextDefinition, ...(cased ? { cased: true } : {}) };
  }

  function isDuplicate(
    ignoringKey: string | null,
    updated: AbbreviationEntry,
    list: readonly AbbreviationEntry[] = entries
  ): boolean {
    const key = abbreviationKey(updated);
    return list.some(
      (entry) => abbreviationKey(entry) !== ignoringKey && abbreviationKey(entry) === key
    );
  }

  // A room term may not shadow an abbreviation inherited from a parent space,
  // so match on the letters alone like v1 does.
  function isInheritedDuplicate(updated: AbbreviationEntry): boolean {
    const letters = updated.term.toLocaleLowerCase();
    return inheritedGroups.some((group) =>
      group.entries.some((entry) => entry.term.toLocaleLowerCase() === letters)
    );
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const updated = draft();
    if (!updated) return;
    if (isDuplicate(null, updated) || isInheritedDuplicate(updated)) {
      duplicate = true;
      return;
    }
    if (await save(upsertAbbreviation(entries, null, updated))) resetForm();
  }

  async function applyEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const replacing = editingKey;
    const updated = draft();
    if (replacing === null || !updated) return;
    if (isDuplicate(replacing, updated) || isInheritedDuplicate(updated)) {
      duplicate = true;
      return;
    }
    if (await save(upsertAbbreviation(entries, replacing, updated))) resetForm();
  }

  function startEdit(entry: AbbreviationEntry): void {
    term = entry.term;
    definition = entry.definition;
    cased = entry.cased === true;
    editingKey = abbreviationKey(entry);
    failed = false;
  }

  function requestRemoval(entry: AbbreviationEntry): void {
    pendingRemoval = entry;
  }

  function confirmRemoval(): void {
    const entry = pendingRemoval;
    pendingRemoval = null;
    if (!entry) return;
    if (isEditing(entry)) resetForm();
    void save(entries.filter((candidate) => abbreviationKey(candidate) !== abbreviationKey(entry)));
  }
</script>

<div class="section">
  {#if canEdit && editingKey === null}
    <SettingsSection
      headingId="room-settings-abbreviations-add"
      title={$i18n.t('room.abbreviationsAdd')}
    >
      <form class="settings-form" onsubmit={add}>
        {#if failed}
          <Alert variant="critical" role="alert">{$i18n.t('room.abbreviationsFailed')}</Alert>
        {/if}
        {#if duplicate}
          <Alert variant="critical" role="alert">
            {$i18n.t('room.abbreviationsDuplicate')}
          </Alert>
        {/if}
        <div class="settings-field">
          <Label for="room-abbr-term">{$i18n.t('room.abbreviationsTerm')}</Label>
          <TextInput
            id="room-abbr-term"
            bind:value={term}
            placeholder={$i18n.t('room.abbreviationsTermPlaceholder')}
          />
        </div>
        <div class="settings-field">
          <Label for="room-abbr-definition">{$i18n.t('room.abbreviationsDefinition')}</Label>
          <TextInput
            id="room-abbr-definition"
            bind:value={definition}
            placeholder={$i18n.t('room.abbreviationsDefinitionPlaceholder')}
          />
        </div>
        <label class="cased-option">
          <input type="checkbox" bind:checked={cased} />
          {$i18n.t('room.abbreviationsCased')}
        </label>
        <div class="actions">
          <Button
            type="submit"
            loading={busy}
            disabled={term.trim() === '' || definition.trim() === ''}
          >
            {$i18n.t('room.abbreviationsAdd')}
          </Button>
        </div>
      </form>
    </SettingsSection>
  {/if}

  <SettingsSection
    headingId="room-settings-abbreviations"
    title={totalCount > 0
      ? $i18n.t('room.abbreviationsCount', { count: totalCount })
      : $i18n.t('room.settingsAbbreviations')}
    description={$i18n.t('room.abbreviationsHint')}
  >
    {#if entries.length > 0 || inheritedGroups.length > 0}
      <ul class="settings-rows">
        {#each entries as entry (abbreviationKey(entry))}
          {#if isEditing(entry)}
            <SettingsRow class="editing">
              {#snippet copy()}
                <form class="inline-editor" onsubmit={applyEdit}>
                  {#if failed}
                    <Alert variant="critical" role="alert"
                      >{$i18n.t('room.abbreviationsFailed')}</Alert
                    >
                  {/if}
                  {#if duplicate}
                    <Alert variant="critical" role="alert">
                      {$i18n.t('room.abbreviationsDuplicate')}
                    </Alert>
                  {/if}
                  <div class="settings-field">
                    <Label for="room-abbr-edit-term">{$i18n.t('room.abbreviationsTerm')}</Label>
                    <TextInput
                      id="room-abbr-edit-term"
                      bind:value={term}
                      placeholder={$i18n.t('room.abbreviationsTermPlaceholder')}
                    />
                  </div>
                  <div class="settings-field">
                    <Label for="room-abbr-edit-definition">
                      {$i18n.t('room.abbreviationsDefinition')}
                    </Label>
                    <TextInput
                      id="room-abbr-edit-definition"
                      bind:value={definition}
                      placeholder={$i18n.t('room.abbreviationsDefinitionPlaceholder')}
                    />
                  </div>
                  <label class="cased-option">
                    <input type="checkbox" bind:checked={cased} />
                    {$i18n.t('room.abbreviationsCased')}
                  </label>
                  <div class="actions">
                    <Button
                      type="submit"
                      loading={busy}
                      disabled={term.trim() === '' || definition.trim() === ''}
                    >
                      {$i18n.t('room.abbreviationsSave')}
                    </Button>
                  </div>
                </form>
              {/snippet}
              {#if canEdit}
                <IconButton
                  variant="subtle"
                  size="small"
                  label={$i18n.t('room.abbreviationsCancel')}
                  disabled={busy}
                  onclick={resetForm}
                >
                  <XIcon />
                </IconButton>
              {/if}
            </SettingsRow>
          {:else}
            <SettingsRow
              title={entry.term}
              description={entry.definition}
              badge={entry.cased ? $i18n.t('room.abbreviationsCased') : undefined}
            >
              {#if canEdit}
                <IconButton
                  variant="subtle"
                  size="small"
                  label={$i18n.t('room.abbreviationsEdit', { term: entry.term })}
                  disabled={busy}
                  onclick={() => startEdit(entry)}
                >
                  <PencilIcon />
                </IconButton>
                <IconButton
                  variant="subtle"
                  size="small"
                  label={$i18n.t('room.abbreviationsRemove', { term: entry.term })}
                  disabled={busy}
                  onclick={() => requestRemoval(entry)}
                >
                  <TrashIcon />
                </IconButton>
              {/if}
            </SettingsRow>
          {/if}
        {/each}
        {#each inheritedGroups as group (group.spaceId)}
          {#each group.entries as entry (`${group.spaceId}:${entry.term}`)}
            <SettingsRow
              title={entry.term}
              description={entry.definition}
              badge={$i18n.t('room.abbreviationsSpaceTag', { space: group.spaceName })}
            />
          {/each}
        {/each}
      </ul>
    {:else}
      <p class="status settings-form">
        {$i18n.t(canEdit ? 'room.abbreviationsEmptyForm' : 'room.abbreviationsEmpty')}
      </p>
    {/if}
  </SettingsSection>
</div>

<ConfirmDialog
  open={pendingRemoval !== null}
  onOpenChange={(next: boolean) => {
    if (!next && busy === false) pendingRemoval = null;
  }}
  title={$i18n.t('room.abbreviationsRemoveConfirm', { term: pendingRemoval?.term ?? '' })}
  confirmLabel={$i18n.t('room.remove')}
  {busy}
  onConfirm={confirmRemoval}
/>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }

  .status {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .section :global(.setting-row.editing) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .inline-editor {
    display: grid;
    gap: var(--space-400);
    min-width: 0;
  }

  .cased-option {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
