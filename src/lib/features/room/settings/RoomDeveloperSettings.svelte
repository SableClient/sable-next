<script lang="ts">
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomListItemView,
  } from '#src/generated/protocol';

  import { untrack } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { parseJsonObject } from '#lib/json-object.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  import { canSendState } from './permission-groups';
  import RoomDeveloperAccountData from './RoomDeveloperAccountData.svelte';
  import RoomDeveloperData from './RoomDeveloperData.svelte';
  import RoomDeveloperDiagnostics from './RoomDeveloperDiagnostics.svelte';
  import RoomDeveloperEvent from './RoomDeveloperEvent.svelte';

  import '#lib/ui/primitives/settings-row.css';
  import CodeTextArea from '#lib/ui/primitives/CodeTextArea.svelte';
  import CopyValue from '#lib/ui/primitives/CopyValue.svelte';
  import ExplorerShell, { type ExplorerGroup } from '#lib/ui/primitives/ExplorerShell.svelte';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    room: RoomListItemView | null;
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
  let picked = $state<string | null | undefined>(undefined);

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
  let stateGroups = $derived.by((): ExplorerGroup[] => {
    const query = typeFilter.trim().toLocaleLowerCase();
    return stateTypes
      .filter(
        ([type, keys]) =>
          !query ||
          type.toLocaleLowerCase().includes(query) ||
          keys.some((key) => key.toLocaleLowerCase().includes(query))
      )
      .map(([type, keys]) => ({
        id: type,
        label: type,
        items: [...keys].sort().map((key) => ({
          id: stateId(type, key),
          label: key === '' ? i18n.t('room.devBrowserEmptyKey') : key,
          title: key,
        })),
      }));
  });

  function stateId(type: string, key: string): string {
    return JSON.stringify([type, key]);
  }

  $effect(() => {
    if (roomId) untrack(() => void browse());
  });

  async function browse(): Promise<void> {
    const target = roomId;
    if (!target || browsing) return;

    browsing = true;
    browseFailed = false;
    try {
      stateEvents = await core.rpc.room_state.fullState({ room_id: target });
    } catch (error) {
      console.warn('[sable room] full state unavailable', error);
      browseFailed = true;
    } finally {
      browsing = false;
    }
  }

  function edit(type: string, key: string): void {
    picked = type === '' ? null : stateId(type, key);
    eventType = type;
    stateKey = key;
    content = '{}';
    outcome = null;
    sent = false;
    if (type !== '') void load();
  }

  async function load(): Promise<void> {
    const target = roomId;
    const type = eventType.trim();
    if (!target || type === '') return;

    const request = picked;
    loading = true;
    outcome = null;
    sent = false;
    try {
      const existing = await core.rpc.room_state.event({
        room_id: target,
        event_type: type,
        state_key: stateKey,
      });
      if (picked !== request) return;
      if (existing === null || existing === undefined) {
        outcome = 'missing';
        content = '{}';
        return;
      }
      content = JSON.stringify(existing, null, 2);
    } catch (error) {
      if (picked !== request) return;
      console.warn('[sable room] state event unreadable', error);
      outcome = 'failed';
    } finally {
      if (picked === request) loading = false;
    }
  }

  async function send(): Promise<void> {
    const target = roomId;
    if (!target || !canSend || sending || loading) return;

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
      await core.rpc.room_state.sendEvent({
        room_id: target,
        event_type: eventType.trim(),
        state_key: stateKey,
        content: parsed,
      });
      sent = true;
      if (picked === null) {
        picked = stateId(eventType.trim(), stateKey);
        void browse();
      }
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
      title={i18n.t('room.devBrowserTitle')}
      description={i18n.t('room.devBrowserDescription')}
    >
      <div class="settings-form">
        {#if browseFailed}
          <Alert variant="critical" role="alert">{i18n.t('common.stateEventRejected')}</Alert>
        {/if}
        <ExplorerShell
          label={i18n.t('room.devBrowserTitle')}
          groups={stateGroups}
          selected={picked}
          bind:query={typeFilter}
          filterLabel={i18n.t('room.devBrowserFilter')}
          empty={i18n.t('room.devBrowserEmpty')}
          loading={browsing}
          detailLoading={loading}
          noMatches={i18n.t('common.noMatches')}
          placeholder={i18n.t('room.devBrowserPick')}
          onSelect={(id) => {
            const [type, key] = JSON.parse(id) as [string, string];
            edit(type, key);
          }}
          onBack={() => (picked = undefined)}
        >
          {#snippet toolbar()}
            <Button size="field" variant="ghost" loading={browsing} onclick={() => void browse()}>
              {i18n.t('common.reload')}
            </Button>
            <Button size="field" variant="secondary" onclick={() => edit('', '')}>
              <PlusIcon aria-hidden="true" />
              {i18n.t('room.devBrowserNew')}
            </Button>
          {/snippet}
          {#snippet head()}
            {#if picked === null}
              <FormField fieldId="room-dev-type" label={i18n.t('room.devEventType')}>
                <TextInput
                  id="room-dev-type"
                  bind:value={eventType}
                  placeholder="m.room.topic"
                  autocomplete="off"
                  spellcheck="false"
                />
              </FormField>
              <FormField fieldId="room-dev-key" label={i18n.t('room.devStateKey')}>
                <TextInput
                  id="room-dev-key"
                  bind:value={stateKey}
                  autocomplete="off"
                  spellcheck="false"
                />
              </FormField>
            {:else}
              <h4 class="state-head"><CopyValue value={eventType} mono={false} /></h4>
              {#if stateKey !== ''}<span class="state-key"
                  ><CopyValue value={stateKey} mono={false} /></span
                >{/if}
            {/if}
          {/snippet}
          <form
            class="state-editor"
            onsubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <CodeTextArea
              id="room-dev-content"
              aria-label={i18n.t('room.devContent')}
              language="json"
              rows={20}
              bind:value={content}
              disabled={loading}
              readonly={!canEditState}
              error={outcome === 'json'}
            />
            {#if outcome === 'json'}
              <Alert variant="critical" role="alert">{i18n.t('room.devInvalidJson')}</Alert>
            {:else if outcome === 'failed'}
              <Alert variant="critical" role="alert">{i18n.t('common.stateEventRejected')}</Alert>
            {:else if outcome === 'missing'}
              <Alert variant="info" role="status">{i18n.t('room.devMissing')}</Alert>
            {:else if sent}
              <Alert variant="success" role="status">{i18n.t('room.devSent')}</Alert>
            {/if}
            {#if canEditState}
              <div class="actions">
                <Button type="submit" size="small" loading={sending} disabled={!canSend || loading}>
                  {i18n.t('room.devSend')}
                </Button>
              </div>
            {/if}
          </form>
        </ExplorerShell>
      </div>
    </SettingsSection>
  {/if}
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

  .state-editor {
    display: grid;
    gap: var(--space-300);
  }

  .state-head {
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-medium);
    margin: 0;
    min-width: 0;
  }

  .state-key {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    min-width: 0;
  }
</style>
