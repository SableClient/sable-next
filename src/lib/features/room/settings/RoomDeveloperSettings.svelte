<script lang="ts">
  import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
  import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  import { canSendState } from './permission-groups';

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

  let roomId = $derived(room?.room_id ?? null);
  let canEditState = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, eventType.trim())
  );
  let canSend = $derived(canEditState && eventType.trim() !== '');

  async function load(): Promise<void> {
    const target = roomId;
    const type = eventType.trim();
    if (!target || type === '' || loading) return;

    loading = true;
    outcome = null;
    sent = false;
    try {
      const existing = await core.roomStateEvent(target, type, stateKey);
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      outcome = 'json';
      sent = false;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      outcome = 'json';
      sent = false;
      return;
    }

    sending = true;
    outcome = null;
    sent = false;
    try {
      await core.sendStateEvent(target, eventType.trim(), stateKey, parsed);
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
  <SettingsSection
    headingId="room-developer-state"
    title={$i18n.t('room.devStateTitle')}
    description={$i18n.t('room.devStateDescription')}
  >
    <form class="settings-form" onsubmit={send}>
      <div class="settings-field">
        <Label for="room-dev-type">{$i18n.t('room.devEventType')}</Label>
        <TextInput
          id="room-dev-type"
          bind:value={eventType}
          placeholder="m.room.topic"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div class="settings-field">
        <Label for="room-dev-key">{$i18n.t('room.devStateKey')}</Label>
        <TextInput id="room-dev-key" bind:value={stateKey} autocomplete="off" spellcheck="false" />
      </div>

      <div class="settings-field">
        <Label for="room-dev-content">{$i18n.t('room.devContent')}</Label>
        <TextArea id="room-dev-content" bind:value={content} rows={10} spellcheck="false" />
      </div>

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
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-2);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
