<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import DatabaseIcon from 'phosphor-svelte/lib/DatabaseIcon';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  const core = useCoreClient();
  let types = $state<string[]>([]);
  let selected = $state<string | null | undefined>(undefined);
  let eventType = $state('');
  let content = $state('{}');
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<'json' | 'failed' | null>(null);
  let saved = $state(false);

  async function refresh(): Promise<void> {
    if (!core.session) return;
    try {
      types = await core.commands.accountDataTypes();
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
      const value = await core.commands.accountData(type);
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
    if (!type || saving) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      error = 'json';
      saved = false;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      error = 'json';
      saved = false;
      return;
    }

    saving = true;
    error = null;
    saved = false;
    try {
      await core.commands.setAccountData(type, parsed);
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
      title={$i18n.t('settings.developerAccountDataAdd')}
      description={$i18n.t('settings.developerAccountDataDescription')}
      icon={DatabaseIcon}
    >
      <Button variant="secondary" size="small" onclick={() => void open(null)}>
        {$i18n.t('settings.developerAccountDataAdd')}
      </Button>
    </SettingsRow>
  </ul>

  {#if types.length === 0}
    <p class="empty">{$i18n.t('settings.developerAccountDataEmpty')}</p>
  {:else}
    <ul class="event-list">
      {#each [...types].sort() as type (type)}
        <li>
          <Button
            variant={selected === type ? 'primary' : 'ghost'}
            size="small"
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
      <div class="field">
        <Label for="developer-account-data-type"
          >{$i18n.t('settings.developerAccountDataType')}</Label
        >
        <TextInput
          id="developer-account-data-type"
          bind:value={eventType}
          disabled={selected !== null}
          autocomplete="off"
          spellcheck={false}
        />
      </div>
      <div class="field">
        <Label for="developer-account-data-content"
          >{$i18n.t('settings.developerAccountDataContent')}</Label
        >
        <TextArea
          id="developer-account-data-content"
          bind:value={content}
          disabled={loading}
          error={error === 'json'}
          spellcheck={false}
          class="account-data-content"
        />
      </div>
      {#if error === 'json'}
        <Alert variant="critical">{$i18n.t('settings.developerAccountDataInvalidJson')}</Alert>
      {:else if error === 'failed'}
        <Alert variant="critical">{$i18n.t('settings.developerAccountDataFailed')}</Alert>
      {:else if saved}
        <Alert variant="success">{$i18n.t('settings.developerAccountDataSaved')}</Alert>
      {/if}
      <div class="editor-actions">
        <Button variant="ghost" size="small" onclick={() => (selected = undefined)}>
          {$i18n.t('settings.developerAccountDataClose')}
        </Button>
        <Button type="submit" variant="primary" size="small" loading={saving}>
          {$i18n.t('settings.developerAccountDataSave')}
        </Button>
      </div>
    </form>
  {/if}
</div>

<style>
  .account-data,
  .editor {
    display: grid;
    gap: var(--space-2);
  }

  .empty {
    font-size: var(--font-size-small);
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .event-list {
    display: grid;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    max-height: 14rem;
    overflow: auto;
    padding: 0;
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  :global(.account-data-content) {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
  }

  .editor-actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
