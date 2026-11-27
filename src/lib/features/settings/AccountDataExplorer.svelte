<script lang="ts" module>
  import type { SealStateView } from '#src/generated/protocol';

  export interface AccountDataSource {
    types(): Promise<string[]>;
    read(type: string): Promise<{ content: unknown; seal: SealStateView }>;
    write(type: string, content: object, seal: SealStateView): Promise<void>;
    serverManaged?: readonly string[];
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import { parseJsonObject } from '#lib/json-object.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import CopyValue from '#lib/ui/primitives/CopyValue.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import ExplorerShell, { type ExplorerGroup } from '#lib/ui/primitives/ExplorerShell.svelte';
  import CodeTextArea from '#lib/ui/primitives/CodeTextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  interface Props {
    source: AccountDataSource;
    label: string;
  }

  let { source, label }: Props = $props();
  let types = $state.raw<string[]>([]);
  let selected = $state<string | null | undefined>(undefined);
  let eventType = $state('');
  let content = $state('{}');
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<'json' | 'failed' | null>(null);
  let saved = $state(false);
  let seal = $state<SealStateView>('plain');
  let query = $state('');
  let confirmingDelete = $state(false);
  let deleting = $state(false);
  const groups = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    const byNamespace: Record<string, string[]> = {};
    for (const type of [...types].sort()) {
      if (!type.toLocaleLowerCase().includes(needle)) continue;
      (byNamespace[type.split('.').slice(0, -1).join('.')] ??= []).push(type);
    }
    return Object.entries(byNamespace).sort(([left], [right]) => left.localeCompare(right));
  });
  const shellGroups = $derived<ExplorerGroup[]>(
    groups.map(([namespace, entries]) => ({
      id: namespace,
      label: namespace || '-',
      items: entries.map((type) => ({
        id: type,
        label: type.slice(namespace.length + (namespace ? 1 : 0)),
        title: type,
      })),
    }))
  );
  const serverManaged = $derived(source.serverManaged?.includes(eventType.trim()) ?? false);

  let listing = $state(false);
  let readFailed = $state(false);
  let reading = 0;

  async function refresh(): Promise<void> {
    listing = true;
    try {
      types = await source.types();
    } catch {
      types = [];
    } finally {
      listing = false;
    }
  }

  $effect(() => {
    void source;
    untrack(() => {
      selected = undefined;
      void refresh();
    });
  });

  async function open(type: string | null): Promise<void> {
    const request = ++reading;
    selected = type;
    eventType = type ?? '';
    error = null;
    saved = false;
    readFailed = false;
    seal = 'plain';
    content = '{}';
    if (type === null) {
      loading = false;
      return;
    }
    loading = true;
    try {
      const read = await source.read(type);
      if (request !== reading) return;
      seal = read.seal;
      content = JSON.stringify(read.content ?? {}, null, 2);
    } catch {
      if (request !== reading) return;
      error = 'failed';
      readFailed = true;
    } finally {
      if (request === reading) loading = false;
    }
  }

  async function remove(): Promise<void> {
    const type = selected;
    if (!type || deleting) return;
    deleting = true;
    error = null;
    saved = false;
    try {
      await source.write(type, {}, 'plain');
      content = '{}';
      seal = 'plain';
      confirmingDelete = false;
    } catch {
      error = 'failed';
    } finally {
      deleting = false;
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const type = eventType.trim();
    if (!type || saving || serverManaged || loading || readFailed) return;
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
      await source.write(type, parsed, seal);
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

<div class="settings-form">
  <ExplorerShell
    {label}
    groups={shellGroups}
    {selected}
    bind:query
    filterLabel={i18n.t('settings.developerAccountDataFilter')}
    empty={i18n.t('settings.developerAccountDataEmpty')}
    noMatches={i18n.t('common.noMatches')}
    placeholder={i18n.t('settings.developerAccountDataPick')}
    loading={listing}
    detailLoading={loading}
    onSelect={(type) => void open(type)}
    onBack={() => (selected = undefined)}
  >
    {#snippet toolbar()}
      <Button
        size="field"
        variant="secondary"
        id="account-data-add"
        onclick={() => void open(null)}
      >
        <PlusIcon aria-hidden="true" />
        {i18n.t('settings.developerAccountDataAdd')}
      </Button>
    {/snippet}
    {#snippet head()}
      {#if selected === null}
        <FormField
          fieldId="developer-account-data-type"
          label={i18n.t('settings.developerAccountDataType')}
        >
          <TextInput
            id="developer-account-data-type"
            bind:value={eventType}
            autocomplete="off"
            spellcheck={false}
            placeholder="com.example.my_data"
          />
        </FormField>
      {:else if selected}
        <h4 class="editing-type"><CopyValue value={selected} mono={false} /></h4>
        {#if seal === 'sealed'}
          <StatusBadge label={i18n.t('settings.developerAccountDataEncrypted')} variant="success" />
        {:else if seal === 'locked'}
          <StatusBadge
            label={i18n.t('settings.developerAccountDataLockedBadge')}
            variant="warning"
          />
        {/if}
      {/if}
    {/snippet}
    <form class="editor" onsubmit={save}>
      <CodeTextArea
        id="developer-account-data-content"
        aria-label={i18n.t('settings.developerAccountDataContent')}
        language="json"
        rows={24}
        bind:value={content}
        disabled={loading}
        readonly={serverManaged}
        error={error === 'json'}
      />
      {#if seal === 'sealed'}
        <p class="note">{i18n.t('settings.developerAccountDataSealed')}</p>
      {:else if seal === 'locked'}
        <Alert variant="warning">{i18n.t('settings.developerAccountDataLocked')}</Alert>
      {/if}
      {#if serverManaged}
        <Alert variant="info">{i18n.t('settings.developerAccountDataServerManaged')}</Alert>
      {:else if error === 'json'}
        <Alert variant="critical">{i18n.t('settings.developerAccountDataInvalidJson')}</Alert>
      {:else if error === 'failed'}
        <Alert variant="critical">{i18n.t('settings.developerAccountDataFailed')}</Alert>
      {:else if saved}
        <Alert variant="success">{i18n.t('settings.developerAccountDataSaved')}</Alert>
      {/if}
      {#if !serverManaged}
        <div class="editor-actions">
          {#if selected !== null}
            <Button
              variant="danger"
              size="small"
              disabled={deleting || loading || readFailed || content.trim() === '{}'}
              onclick={() => (confirmingDelete = true)}
            >
              {i18n.t('settings.developerAccountDataDelete')}
            </Button>
          {/if}
          <Button
            type="submit"
            variant="primary"
            size="small"
            loading={saving}
            disabled={loading || readFailed}
          >
            {i18n.t('common.save')}
          </Button>
        </div>
      {/if}
    </form>
  </ExplorerShell>
</div>

<ConfirmDialog
  bind:open={confirmingDelete}
  title={i18n.t('settings.developerAccountDataDeleteConfirm', { type: selected ?? '' })}
  description={i18n.t('settings.developerAccountDataDeleteDescription')}
  confirmLabel={i18n.t('settings.developerAccountDataDelete')}
  busy={deleting}
  onConfirm={() => void remove()}
/>

<style>
  .editor {
    display: grid;
    gap: var(--space-300);
  }

  .note {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .editing-type {
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-medium);
    margin: 0;
    min-width: 0;
  }

  .editor-actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
