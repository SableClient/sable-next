<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { parseJsonObject } from '#lib/json-object.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
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

  let rooms = $derived(roomList.rooms.filter((room) => room.state === 'joined'));
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
      await core.commands.sendStateEvent(roomId, eventType.trim(), stateKey, parsed);
      sent = true;
    } catch (failure) {
      console.warn('[sable settings] state event rejected', failure);
      error = 'failed';
    } finally {
      sending = false;
    }
  }
</script>

<form class="state-event settings-form" onsubmit={send}>
  <p class="hint">{$i18n.t('settings.stateEventDescription')}</p>

  <FormField fieldId="state-event-room" label={$i18n.t('settings.stateEventRoom')}>
    <Select
      id="state-event-room"
      bind:value={roomId}
      items={[
        { value: '', label: '' },
        ...rooms.map((room) => ({ value: room.room_id, label: room.name ?? room.room_id })),
      ]}
    />
  </FormField>

  <FormField fieldId="state-event-type" label={$i18n.t('settings.stateEventType')}>
    <TextInput
      id="state-event-type"
      bind:value={eventType}
      autocomplete="off"
      spellcheck={false}
      placeholder="m.room.topic"
    />
  </FormField>

  <FormField fieldId="state-event-key" label={$i18n.t('settings.stateEventStateKey')}>
    <TextInput id="state-event-key" bind:value={stateKey} autocomplete="off" spellcheck={false} />
  </FormField>

  <FormField fieldId="state-event-content" label={$i18n.t('settings.stateEventContent')}>
    <TextArea
      id="state-event-content"
      bind:value={content}
      spellcheck={false}
      error={error === 'json'}
      class="state-event-content"
    />
  </FormField>

  {#if error === 'json'}
    <Alert variant="critical" role="alert">{$i18n.t('settings.stateEventInvalidJson')}</Alert>
  {:else if error === 'failed'}
    <Alert variant="critical" role="alert">{$i18n.t('settings.stateEventFailed')}</Alert>
  {:else if sent}
    <Alert variant="success" role="status">{$i18n.t('settings.stateEventSent')}</Alert>
  {/if}

  <div class="actions">
    <Button type="submit" variant="primary" disabled={!canSend} loading={sending}>
      {$i18n.t('settings.stateEventSend')}
    </Button>
  </div>
</form>

<style>
  .state-event {
    display: grid;
    gap: var(--space-400);
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

  :global(.state-event-content) {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
  }
</style>
