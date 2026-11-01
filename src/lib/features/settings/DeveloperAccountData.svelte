<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { parseJsonObject } from '#lib/json-object.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/settings-row.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  const core = useCoreClient();
  let types = $state.raw<string[]>([]);
  let selected = $state<string | null | undefined>(undefined);
  let eventType = $state('');
  let content = $state('{}');
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<'json' | 'failed' | null>(null);
  let saved = $state(false);
  const serverManaged = $derived(['m.push_rules', 'm.fully_read'].includes(eventType.trim()));

  async function refresh(): Promise<void> {
    if (!core.session) return;
    try {
      types = await core.rpc.account.dataTypes();
    } catch {
      types = [];
    }
  }

  $effect(() => {
    const accountId = core.session?.account_id;
    if (accountId === undefined) {
      types = [];
      selected = undefined;
      return;
    }
    void refresh();
  });

  async function open(type: string | null): Promise<void> {
    selected = type;
    eventType = type ?? '';
    error = null;
    saved = false;
    if (type === null) {
      content = '{}';
      return;
    }
    loading = true;
    try {
      const value = await core.rpc.account.data({ event_type: type });
      content = JSON.stringify(value ?? {}, null, 2);
    } catch {
      error = 'failed';
    } finally {
      loading = false;
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const type = eventType.trim();
    if (!type || saving || serverManaged) return;
    const parsed = parseJsonObject(content);
    if (!parsed) {
      error = 'json';
      saved = false;
      return;
    }

    saving = true;
    error = null;
    saved = false;
    try {
      await core.rpc.account.setData({ event_type: type, content: parsed });
      await refresh();
      selected = type;
      saved = true;
    } catch {
      error = 'failed';
    } finally {
      saving = false;
    }
  }
</script>

<div class="account-data">
  <ul class="settings">
    <SettingsRow
      id="account-data-add"
      title={i18n.t('settings.developerAccountDataAdd')}
      description={i18n.t('settings.developerAccountDataDescription')}
    >
      <Button variant="secondary" size="small" onclick={() => void open(null)}>
        {i18n.t('settings.developerAccountDataAdd')}
      </Button>
    </SettingsRow>
  </ul>

  <div class="settings-form account-data-body">
    {#if types.length === 0}
      <p class="empty">{i18n.t('settings.developerAccountDataEmpty')}</p>
    {:else}
      <ul class="event-list" {@attach scrollHint}>
        {#each [...types].sort() as type (type)}
          <li>
            <Button
              variant={selected === type ? 'primary' : 'ghost'}
              size="small"
              class="choice"
              aria-pressed={selected === type}
              block
              onclick={() => void open(type)}
            >
              {type}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if selected !== undefined}
      <form class="editor" onsubmit={save}>
        <FormField
          fieldId="developer-account-data-type"
          label={i18n.t('settings.developerAccountDataType')}
        >
          <TextInput
            id="developer-account-data-type"
            bind:value={eventType}
            disabled={selected !== null}
            autocomplete="off"
            spellcheck={false}
          />
        </FormField>
        <FormField
          fieldId="developer-account-data-content"
          label={i18n.t('settings.developerAccountDataContent')}
        >
          <TextArea
            id="developer-account-data-content"
            bind:value={content}
            disabled={loading}
            readonly={serverManaged}
            error={error === 'json'}
            spellcheck={false}
            class="account-data-content"
          />
        </FormField>
        {#if serverManaged}
          <Alert variant="info">{i18n.t('settings.developerAccountDataServerManaged')}</Alert>
        {:else if error === 'json'}
          <Alert variant="critical">{i18n.t('settings.developerAccountDataInvalidJson')}</Alert>
        {:else if error === 'failed'}
          <Alert variant="critical">{i18n.t('settings.developerAccountDataFailed')}</Alert>
        {:else if saved}
          <Alert variant="success">{i18n.t('settings.developerAccountDataSaved')}</Alert>
        {/if}
        <div class="editor-actions">
          <Button variant="ghost" size="small" onclick={() => (selected = undefined)}>
            {i18n.t('common.close')}
          </Button>
          {#if !serverManaged}
            <Button type="submit" variant="primary" size="small" loading={saving}>
              {i18n.t('common.save')}
            </Button>
          {/if}
        </div>
      </form>
    {/if}
  </div>
</div>

<style>
  .account-data-body,
  .editor {
    display: grid;
    gap: var(--space-300);
  }

  .empty {
    font-size: var(--font-size-small);
    margin: 0;
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .event-list {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    max-height: 14rem;
    overflow: auto;
    padding: 0;
  }

  :global(.account-data-content) {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    font-variant-ligatures: none;
  }

  .editor-actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
