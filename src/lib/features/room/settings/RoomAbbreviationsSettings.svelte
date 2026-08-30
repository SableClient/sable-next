<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { canSendState } from './permission-groups';
  import {
    ABBREVIATIONS_EVENT_TYPE,
    readAbbreviations,
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

  let entries = $state.raw<AbbreviationEntry[]>([]);
  let term = $state('');
  let definition = $state('');
  let busy = $state(false);
  let failed = $state(false);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, ABBREVIATIONS_EVENT_TYPE)
  );

  $effect(() => {
    const target = roomId;
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

  async function save(next: readonly AbbreviationEntry[]): Promise<void> {
    const target = roomId;
    if (!target || busy) return;

    busy = true;
    failed = false;
    try {
      await core.commands.sendStateEvent(target, ABBREVIATIONS_EVENT_TYPE, '', { entries: next });
      entries = [...next];
    } catch (error) {
      console.warn('[sable room] abbreviation save failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  function add(event: SubmitEvent): void {
    event.preventDefault();
    const nextTerm = term.trim();
    const nextDefinition = definition.trim();
    if (nextTerm === '' || nextDefinition === '') return;

    const kept = entries.filter(
      (entry) => entry.term.toLocaleLowerCase() !== nextTerm.toLocaleLowerCase()
    );
    void save([...kept, { term: nextTerm, definition: nextDefinition }]).then(() => {
      term = '';
      definition = '';
    });
  }
</script>

<div class="section">
  <SettingsSection
    headingId="room-settings-abbreviations"
    title={$i18n.t('room.settingsAbbreviations')}
    description={$i18n.t('room.abbreviationsHint')}
  >
    {#if entries.length > 0}
      <ul class="settings-rows">
        {#each entries as entry (entry.term)}
          <li class="settings-row">
            <div class="settings-row-copy">
              <span class="settings-row-name">{entry.term}</span>
              <p>{entry.definition}</p>
            </div>
            {#if canEdit}
              <div class="settings-row-control">
                <IconButton
                  variant="ghost"
                  size="small"
                  label={$i18n.t('room.abbreviationsRemove', { term: entry.term })}
                  disabled={busy}
                  onclick={() => {
                    void save(entries.filter((candidate) => candidate.term !== entry.term));
                  }}
                >
                  <TrashIcon />
                </IconButton>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">{$i18n.t('room.abbreviationsEmpty')}</p>
    {/if}

    {#if canEdit}
      <form class="settings-form" onsubmit={add}>
        {#if failed}
          <Alert variant="critical" role="alert">{$i18n.t('room.abbreviationsFailed')}</Alert>
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
    {/if}
  </SettingsSection>
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-300);
  }

  .status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-300) var(--space-400);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
