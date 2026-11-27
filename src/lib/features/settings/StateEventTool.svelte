<script lang="ts">
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { currentLocale, i18n } from '#lib/i18n.js';
  import { parseJsonObject } from '#lib/json-object.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import CodeTextArea from '#lib/ui/primitives/CodeTextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const roomList = useRoomList();

  let roomId = $state('');
  let eventType = $state('');
  let stateKey = $state('');
  let content = $state('{}');
  let sending = $state(false);
  let sent = $state(false);
  let error = $state<'json' | 'failed' | null>(null);

  let rooms = $derived(
    roomList.rooms
      .filter((room) => room.state === 'joined')
      .map((room) => ({
        value: room.room_id,
        label: room.name ?? room.room_id,
        labelClass: 'literal-label',
      }))
      .sort((a, b) => a.label.localeCompare(b.label, currentLocale()))
  );
  let canSend = $derived(roomId !== '' && eventType.trim() !== '' && !sending);

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSend) return;

    const parsed = parseJsonObject(content);
    if (!parsed) {
      error = 'json';
      sent = false;
      return;
    }

    sending = true;
    error = null;
    sent = false;
    try {
      await core.rpc.room_state.sendEvent({
        room_id: roomId,
        event_type: eventType.trim(),
        state_key: stateKey,
        content: parsed,
      });
      sent = true;
    } catch (failure) {
      console.warn('[sable settings] state event rejected', failure);
      error = 'failed';
    } finally {
      sending = false;
    }
  }
</script>

<details class="settings-form disclosure">
  <summary>
    <CaretRightIcon class="caret" aria-hidden="true" />
    {i18n.t('settings.stateEventOpen')}
  </summary>
  <form class="state-event" onsubmit={send}>
    <p class="hint">{i18n.t('settings.stateEventDescription')}</p>

    <FormField fieldId="state-event-room" label={i18n.t('settings.stateEventRoom')}>
      <Select
        id="state-event-room"
        bind:value={roomId}
        items={rooms}
        placeholder={i18n.t('settings.stateEventRoomPlaceholder')}
      />
    </FormField>

    <FormField fieldId="state-event-type" label={i18n.t('settings.stateEventType')}>
      <TextInput
        id="state-event-type"
        bind:value={eventType}
        autocomplete="off"
        spellcheck={false}
        placeholder="m.room.topic"
      />
    </FormField>

    <FormField fieldId="state-event-key" label={i18n.t('settings.stateEventStateKey')}>
      <TextInput id="state-event-key" bind:value={stateKey} autocomplete="off" spellcheck={false} />
    </FormField>

    <FormField fieldId="state-event-content" label={i18n.t('settings.stateEventContent')}>
      <CodeTextArea
        id="state-event-content"
        language="json"
        rows={12}
        bind:value={content}
        error={error === 'json'}
      />
    </FormField>

    {#if error === 'json'}
      <Alert variant="critical" role="alert"
        >{i18n.t('settings.developerAccountDataInvalidJson')}</Alert
      >
    {:else if error === 'failed'}
      <Alert variant="critical" role="alert">{i18n.t('common.stateEventRejected')}</Alert>
    {:else if sent}
      <Alert variant="success" role="status">{i18n.t('settings.stateEventSent')}</Alert>
    {/if}

    <div class="actions">
      <Button type="submit" variant="primary" disabled={!canSend} loading={sending}>
        {i18n.t('settings.stateEventSend')}
      </Button>
    </div>
  </form>
</details>

<style>
  .disclosure {
    display: grid;
  }

  summary {
    align-items: center;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    list-style: none;
    padding: var(--space-200) 0;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:hover {
    color: var(--primary-main);
  }

  summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--space-050);
  }

  summary :global(.caret) {
    flex: none;
    transition: transform var(--duration-fast) ease-out;
  }

  .disclosure[open] summary :global(.caret) {
    transform: rotate(90deg);
  }

  .state-event {
    display: grid;
    gap: var(--space-400);
    padding-top: var(--space-300);
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
