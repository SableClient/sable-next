<script lang="ts">
  import type { RoomPowerLevelsView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { parseJsonObject } from '#lib/json-object.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import '#lib/ui/primitives/settings-row.css';

  interface Props {
    roomId: string;
    levels: RoomPowerLevelsView | null;
    ownPowerLevel: number;
  }

  let { roomId, levels, ownPowerLevel }: Props = $props();
  const core = useCoreClient();

  let eventType = $state('m.room.message');
  let content = $state('{\n  "msgtype": "m.text",\n  "body": ""\n}');
  let sending = $state(false);
  let outcome = $state<'json' | 'failed' | 'sent' | null>(null);

  let canSend = $derived(
    levels !== null && ownPowerLevel >= (levels.events[eventType.trim()] ?? levels.events_default)
  );

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const type = eventType.trim();
    if (type === '' || sending || !canSend) return;

    const parsed = parseJsonObject(content);
    if (!parsed) {
      outcome = 'json';
      return;
    }

    sending = true;
    outcome = null;
    try {
      await core.commands.sendRawEvent(roomId, type, parsed);
      outcome = 'sent';
    } catch (error) {
      console.warn('[sable room] message event rejected', error);
      outcome = 'failed';
    } finally {
      sending = false;
    }
  }
</script>

<SettingsSection
  headingId="room-developer-event"
  title={$i18n.t('room.devEventTitle')}
  description={$i18n.t('room.devEventDescription')}
>
  <form class="settings-form" onsubmit={send}>
    <FormField fieldId="room-dev-event-type" label={$i18n.t('room.devEventType')}>
      <TextInput
        id="room-dev-event-type"
        bind:value={eventType}
        autocomplete="off"
        spellcheck="false"
      />
    </FormField>
    <FormField fieldId="room-dev-event-content" label={$i18n.t('room.devContent')}>
      <TextArea id="room-dev-event-content" bind:value={content} rows={8} spellcheck="false" />
    </FormField>
    {#if outcome === 'json'}
      <Alert variant="critical" role="alert">{$i18n.t('room.devInvalidJson')}</Alert>
    {:else if outcome === 'failed'}
      <Alert variant="critical" role="alert">{$i18n.t('room.devFailed')}</Alert>
    {:else if outcome === 'sent'}
      <Alert variant="success" role="status">{$i18n.t('room.devSent')}</Alert>
    {/if}
    {#if canSend}
      <div class="actions">
        <Button type="submit" loading={sending} disabled={eventType.trim() === ''}>
          {$i18n.t('room.devEventSend')}
        </Button>
      </div>
    {/if}
  </form>
</SettingsSection>

<style>
  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
