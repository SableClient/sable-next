<script lang="ts">
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { parseJsonObject } from '#lib/json-object.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  import { canSendState } from './permission-groups';
  import RoomDeveloperAccountData from './RoomDeveloperAccountData.svelte';
  import RoomDeveloperData from './RoomDeveloperData.svelte';
  import RoomDeveloperDiagnostics from './RoomDeveloperDiagnostics.svelte';
  import RoomDeveloperEvent from './RoomDeveloperEvent.svelte';

  import '#lib/ui/primitives/settings-row.css';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    room: RoomSummary | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  }

  let { room, permissions, levels }: Props = $props();
  const core = useCoreClient();

  let eventType = $state('');
  let stateKey = $state('');
  let content = $state('{}');
  let loading = $state(false);
  let sending = $state(false);
  let sent = $state(false);
  let outcome = $state<'json' | 'failed' | 'missing' | null>(null);
  let stateEvents = $state.raw<unknown[]>([]);
  let browsing = $state(false);
  let browseFailed = $state(false);
  let typeFilter = $state('');
  let openType = $state<string | null>(null);
  let editorRequest = $state(0);

  let roomId = $derived(room?.room_id ?? null);
  let canEditState = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, eventType.trim())
  );
  let canSend = $derived(canEditState && eventType.trim() !== '');
  let stateTypes = $derived.by(() => {
    const byType: Record<string, string[]> = {};
    for (const event of stateEvents) {
      const entry = event as { type?: unknown; state_key?: unknown };
      if (typeof entry.type !== 'string' || typeof entry.state_key !== 'string') continue;
      (byType[entry.type] ??= []).push(entry.state_key);
    }
    return Object.entries(byType).sort(([left], [right]) => left.localeCompare(right));
  });
  let shownTypes = $derived.by(() => {
    const query = typeFilter.trim().toLocaleLowerCase();
    return query
      ? stateTypes.filter(([type]) => type.toLocaleLowerCase().includes(query))
      : stateTypes;
  });

  async function browse(): Promise<void> {
    const target = roomId;
    if (!target || browsing) return;

    browsing = true;
    browseFailed = false;
    try {
      stateEvents = await core.commands.roomFullState(target);
    } catch (error) {
      console.warn('[sable room] full state unavailable', error);
      browseFailed = true;
    } finally {
      browsing = false;
    }
  }

  function edit(type: string, key: string): void {
    eventType = type;
    stateKey = key;
    content = '{}';
    outcome = null;
    sent = false;
    editorRequest += 1;
    if (type !== '') void load();
  }

  function revealEditor(node: HTMLElement): void {
    if (editorRequest === 0) return;
    node.scrollIntoView({ block: 'start' });
    node.querySelector('input')?.focus({ preventScroll: true });
  }

  async function load(): Promise<void> {
    const target = roomId;
    const type = eventType.trim();
    if (!target || type === '' || loading) return;

    loading = true;
    outcome = null;
    sent = false;
    try {
      const existing = await core.commands.roomStateEvent(target, type, stateKey);
      if (existing === null || existing === undefined) {
        outcome = 'missing';
        content = '{}';
        return;
      }
      content = JSON.stringify(existing, null, 2);
    } catch (error) {
      console.warn('[sable room] state event unreadable', error);
      outcome = 'failed';
    } finally {
      loading = false;
    }
  }

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const target = roomId;
    if (!target || !canSend || sending) return;

    const parsed = parseJsonObject(content);
    if (!parsed) {
      outcome = 'json';
      sent = false;
      return;
    }

    sending = true;
    outcome = null;
    sent = false;
    try {
      await core.commands.sendStateEvent(target, eventType.trim(), stateKey, parsed);
      sent = true;
    } catch (error) {
      console.warn('[sable room] state event rejected', error);
      outcome = 'failed';
    } finally {
      sending = false;
    }
  }
</script>

<div class="section">
  {#if room}
    {#key room.room_id}
      <RoomDeveloperDiagnostics {room} />
      <RoomDeveloperData {room} {permissions} {levels} />
    {/key}
  {/if}
  {#if roomId}
    <SettingsSection
      headingId="room-developer-state-browser"
      title={$i18n.t('room.devBrowserTitle')}
      description={$i18n.t('room.devBrowserDescription')}
    >
      {#if browseFailed}
        <div class="settings-form">
          <Alert variant="critical" role="alert">{$i18n.t('room.devFailed')}</Alert>
        </div>
      {/if}
      {#if stateTypes.length > 0}
        <div class="settings-form">
          <TextInput
            type="search"
            bind:value={typeFilter}
            placeholder={$i18n.t('room.devBrowserFilter')}
            aria-label={$i18n.t('room.devBrowserFilter')}
          />
        </div>
        <ul class="settings-rows">
          {#each shownTypes as [type, keys] (type)}
            <SettingsRow
              title={type}
              description={$i18n.t('room.devBrowserCount', { count: keys.length })}
            >
              <Button
                size="small"
                variant="secondary"
                aria-expanded={openType === type}
                onclick={() => {
                  openType = openType === type ? null : type;
                }}
              >
                {openType === type
                  ? $i18n.t('room.devBrowserHide')
                  : $i18n.t('room.devBrowserShow')}
              </Button>
            </SettingsRow>
            {#if openType === type}
              <li class="settings-form">
                <ul class="state-keys">
                  {#each keys as key (key)}
                    <li>
                      <button
                        type="button"
                        class="state-key"
                        onclick={() => {
                          edit(type, key);
                        }}
                      >
                        {key === '' ? $i18n.t('room.devBrowserEmptyKey') : key}
                      </button>
                    </li>
                  {/each}
                </ul>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
      <div class="settings-form">
        <div class="actions">
          <Button variant="secondary" loading={browsing} onclick={() => void browse()}>
            {stateTypes.length > 0
              ? $i18n.t('room.devBrowserReload')
              : $i18n.t('room.devBrowserLoad')}
          </Button>
          <Button
            variant="secondary"
            onclick={() => {
              edit('', '');
            }}
          >
            {$i18n.t('room.devBrowserNew')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  {/if}
  <SettingsSection
    headingId="room-developer-state"
    title={$i18n.t('room.devStateTitle')}
    description={$i18n.t('room.devStateDescription')}
  >
    <form class="settings-form" onsubmit={send} {@attach revealEditor}>
      <FormField fieldId="room-dev-type" label={$i18n.t('room.devEventType')}>
        <TextInput
          id="room-dev-type"
          bind:value={eventType}
          placeholder="m.room.topic"
          autocomplete="off"
          spellcheck="false"
        />
      </FormField>

      <FormField fieldId="room-dev-key" label={$i18n.t('room.devStateKey')}>
        <TextInput id="room-dev-key" bind:value={stateKey} autocomplete="off" spellcheck="false" />
      </FormField>

      <FormField fieldId="room-dev-content" label={$i18n.t('room.devContent')}>
        <TextArea id="room-dev-content" bind:value={content} rows={10} spellcheck="false" />
      </FormField>

      {#if outcome === 'json'}
        <Alert variant="critical" role="alert">{$i18n.t('room.devInvalidJson')}</Alert>
      {:else if outcome === 'failed'}
        <Alert variant="critical" role="alert">{$i18n.t('room.devFailed')}</Alert>
      {:else if outcome === 'missing'}
        <Alert variant="info" role="status">{$i18n.t('room.devMissing')}</Alert>
      {:else if sent}
        <Alert variant="success" role="status">{$i18n.t('room.devSent')}</Alert>
      {/if}

      <div class="actions">
        <Button
          type="button"
          variant="secondary"
          {loading}
          disabled={eventType.trim() === ''}
          onclick={() => {
            void load();
          }}
        >
          {$i18n.t('room.devLoad')}
        </Button>
        {#if canEditState}
          <Button type="submit" loading={sending} disabled={eventType.trim() === ''}>
            {$i18n.t('room.devSend')}
          </Button>
        {/if}
      </div>
    </form>
  </SettingsSection>
  {#if roomId}
    <RoomDeveloperEvent {roomId} {levels} ownPowerLevel={permissions?.own_power_level ?? 0} />
    <RoomDeveloperAccountData {roomId} />
  {/if}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    justify-content: flex-end;
  }

  .state-keys {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .state-key {
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--primary-main);
    cursor: pointer;
    font: inherit;
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
    padding: var(--space-100) var(--space-200);
    text-align: start;
    width: 100%;
  }

  .state-key:hover {
    background: var(--surface-var-container-hover);
  }

  .state-key:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }
</style>
