<script lang="ts">
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

  const KNOWN_TYPES = ['m.fully_read', 'm.tag', 'm.marked_unread', 'com.famedly.marked_unread'];

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();
  const core = useCoreClient();
  const listId = $props.id();

  let eventType = $state('');
  let content = $state('{}');
  let loading = $state(false);
  let saving = $state(false);
  let outcome = $state<'json' | 'failed' | 'missing' | 'saved' | null>(null);

  async function load(): Promise<void> {
    const type = eventType.trim();
    if (type === '' || loading) return;

    loading = true;
    outcome = null;
    try {
      const existing = await core.commands.roomAccountData(roomId, type);
      if (existing === null || existing === undefined) {
        content = '{}';
        outcome = 'missing';
        return;
      }
      content = JSON.stringify(existing, null, 2);
    } catch (error) {
      console.warn('[sable room] room account data unreadable', error);
      outcome = 'failed';
    } finally {
      loading = false;
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const type = eventType.trim();
    if (type === '' || saving) return;

    const parsed = parseJsonObject(content);
    if (!parsed) {
      outcome = 'json';
      return;
    }

    saving = true;
    outcome = null;
    try {
      await core.commands.setRoomAccountData(roomId, type, parsed);
      outcome = 'saved';
    } catch (error) {
      console.warn('[sable room] room account data rejected', error);
      outcome = 'failed';
    } finally {
      saving = false;
    }
  }
</script>

<SettingsSection
  headingId="room-developer-account-data"
  title={$i18n.t('room.devAccountDataTitle')}
  description={$i18n.t('room.devAccountDataDescription')}
>
  <form class="settings-form" onsubmit={save}>
    <FormField fieldId="room-dev-account-type" label={$i18n.t('room.devEventType')}>
      <TextInput
        id="room-dev-account-type"
        bind:value={eventType}
        list={`${listId}-types`}
        placeholder="m.tag"
        autocomplete="off"
        spellcheck="false"
      />
      <datalist id={`${listId}-types`}>
        {#each KNOWN_TYPES as type (type)}
          <option value={type}></option>
        {/each}
      </datalist>
    </FormField>
    <FormField fieldId="room-dev-account-content" label={$i18n.t('room.devContent')}>
      <TextArea id="room-dev-account-content" bind:value={content} rows={8} spellcheck="false" />
    </FormField>
    {#if outcome === 'json'}
      <Alert variant="critical" role="alert">{$i18n.t('room.devInvalidJson')}</Alert>
    {:else if outcome === 'failed'}
      <Alert variant="critical" role="alert">{$i18n.t('room.devFailed')}</Alert>
    {:else if outcome === 'missing'}
      <Alert variant="info" role="status">{$i18n.t('room.devMissing')}</Alert>
    {:else if outcome === 'saved'}
      <Alert variant="success" role="status">{$i18n.t('room.devSent')}</Alert>
    {/if}
    <div class="actions">
      <Button
        type="button"
        variant="secondary"
        {loading}
        disabled={eventType.trim() === ''}
        onclick={() => void load()}
      >
        {$i18n.t('room.devLoad')}
      </Button>
      <Button type="submit" loading={saving} disabled={eventType.trim() === ''}>
        {$i18n.t('room.devSave')}
      </Button>
    </div>
  </form>
</SettingsSection>

<style>
  .actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
