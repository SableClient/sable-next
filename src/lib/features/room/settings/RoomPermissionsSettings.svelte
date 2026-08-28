<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import PencilIcon from 'phosphor-svelte/lib/PencilIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import '#lib/ui/primitives/settings-row.css';

  import {
    levelAt,
    permissionGroups,
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
    type PowerLevelTagMap,
  } from './power-level-tags';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
  }

  let { room, permissions }: Props = $props();
  const core = useCoreClient();

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

  let numberDrafts = $state.raw<Record<string, string>>({});
  let numberErrors = $state.raw<Record<string, string>>({});

  let editingLevel = $state<number | null>(null);
  let editingHasTag = $derived(
    editingLevel !== null && tagForLevel(roleTags, editingLevel) !== null
  );
  let roleNameDraft = $state('');
  let roleColorDraft = $state('');
  let roleSaving = $state(false);
  let roleFailed = $state(false);

  let roomId = $derived(room?.room_id ?? null);
  let groups = $derived(permissionGroups(room?.is_space ?? false));
  let canEdit = $derived(permissions?.can_change_power_levels ?? false);
  let ownLevel = $derived(permissions?.own_power_level ?? 0);

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

  function levelLabel(level: number): string {
    const known = namedLevels.find((entry) => entry.level === level);
    return known ? $i18n.t(known.label) : String(level);
  }

  function options(current: number): { value: string; label: string; disabled?: boolean }[] {
    const named = namedLevels.map((entry) => ({
      value: String(entry.level),
      label: $i18n.t(entry.label),
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
    roleNameDraft = tag?.name ?? levelLabel(level);
    roleColorDraft = tag?.color ?? '';
    roleFailed = false;
  }

  function cancelEditRole(): void {
    editingLevel = null;
  }

  async function saveRole(): Promise<void> {
    const target = roomId;
    const level = editingLevel;
    if (!target || level === null || roleSaving) return;

    const name = roleNameDraft.trim();
    if (name === '') return;

    const color = /^#[0-9a-f]{6}$/i.test(roleColorDraft.trim()) ? roleColorDraft.trim() : null;

    roleSaving = true;
    roleFailed = false;
    try {
      const nextContent = withPowerLevelTag(rawRoleTags, level, { name, color });
      await core.commands.sendStateEvent(target, POWER_LEVEL_TAGS_EVENT_TYPE, '', nextContent);
      rawRoleTags = nextContent;
      editingLevel = null;
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
</script>

<div class="section">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.permFailed')}</Alert>
  {/if}

  {#if loading && levels === null}
    <p class="status" role="status"><Spinner small /></p>
  {:else if levels}
    {#each groups as group (group.label)}
      <SettingsSection headingId={`room-perm-${group.label}`} title={$i18n.t(group.label)}>
        <ul class="settings-rows">
          {#each group.items as item (item.label)}
            {@const level = levelAt(levels, item.location)}
            {@const tag = tagForLevel(roleTags, level)}
            {@const key = locationKey(item.location)}
            {@const numberErrorId = `room-perm-number-error-${item.label.replace(/\./g, '-')}`}
            <li class="settings-row">
              <div class="settings-row-copy">
                <span class="settings-row-name">{$i18n.t(item.label)}</span>
              </div>
              <div class="settings-row-control">
                {#if tag}
                  <span class="role-chip">
                    <span
                      class="role-swatch"
                      style:background-color={tag.color ?? undefined}
                      aria-hidden="true"
                    ></span>
                    <span class="role-name">{tag.name} ({level})</span>
                  </span>
                {:else}
                  <span class="level">{levelLabel(level)}</span>
                {/if}
                {#if canEdit && level <= ownLevel}
                  <IconButton
                    variant="ghost"
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
              </div>
            </li>
          {/each}
        </ul>
      </SettingsSection>
    {/each}

    {#if editingLevel !== null}
      <SettingsSection headingId="room-perm-role-editor" title={$i18n.t('room.permRoleEdit')}>
        <form
          class="settings-form"
          onsubmit={(event) => {
            event.preventDefault();
            void saveRole();
          }}
        >
          {#if roleFailed}
            <Alert variant="critical" role="alert">{$i18n.t('room.permFailed')}</Alert>
          {/if}
          <div class="settings-field">
            <Label for="room-perm-role-name">{$i18n.t('room.permRoleName')}</Label>
            <TextInput id="room-perm-role-name" bind:value={roleNameDraft} required />
          </div>
          <div class="settings-field">
            <Label for="room-perm-role-color">{$i18n.t('room.permRoleColor')}</Label>
            <TextInput
              id="room-perm-role-color"
              bind:value={roleColorDraft}
              placeholder={$i18n.t('room.permRoleColorHint')}
            />
          </div>
          <div class="actions">
            {#if editingHasTag}
              <Button type="button" variant="danger" onclick={removeRole} disabled={roleSaving}>
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

<style>
  .section {
    display: grid;
    gap: var(--space-2);
  }

  .status {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-3) 0;
    text-align: center;
  }

  .level {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .role-chip {
    align-items: center;
    background-color: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius-pill);
    display: inline-flex;
    gap: var(--space-1);
    padding: calc(var(--space-1) / 2) var(--space-2);
  }

  .role-swatch {
    background-color: var(--sable-surface-var-on-container);
    border-radius: var(--radius-pill);
    flex: 0 0 auto;
    height: 0.6rem;
    width: 0.6rem;
  }

  .role-name {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .number-field {
    display: grid;
    gap: calc(var(--space-1) / 2);
    width: 6rem;
  }

  .number-error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
