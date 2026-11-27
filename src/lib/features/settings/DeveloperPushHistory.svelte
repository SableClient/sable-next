<script lang="ts">
  import type { PushHistoryEntry } from '#lib/notifications/push-history.js';
  import {
    forgetPushHistory,
    loadPushHistory,
  } from '#lib/features/notifications/push-history-source.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import CopyValue from '#lib/ui/primitives/CopyValue.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const ALL = '*';
  const stamp = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  let entries = $state.raw<PushHistoryEntry[] | null>(null);
  let filter = $state(ALL);
  let failed = $state(false);

  let outcomes = $derived([...new Set((entries ?? []).map((entry) => entry.outcome))].sort());
  let shown = $derived(
    (entries ?? []).filter((entry) => filter === ALL || entry.outcome === filter)
  );

  async function load(): Promise<void> {
    failed = false;
    try {
      entries = await loadPushHistory();
    } catch {
      failed = true;
    }
  }

  $effect(() => {
    void load();
  });

  async function clear(): Promise<void> {
    failed = false;
    try {
      await forgetPushHistory();
      entries = [];
      filter = ALL;
    } catch {
      failed = true;
    }
  }
</script>

<ul class="settings settings-rows">
  <SettingsRow
    id="push-history"
    title={i18n.t('settings.developerPushHistoryTitle')}
    description={i18n.t('settings.developerPushHistoryDescription')}
  >
    <div class="actions">
      <Button variant="secondary" size="small" onclick={() => void load()}>
        {i18n.t('common.refresh')}
      </Button>
      {#if entries && entries.length > 0}
        <Button variant="secondary" size="small" onclick={() => void clear()}>
          {i18n.t('common.clear')}
        </Button>
      {/if}
    </div>
  </SettingsRow>
</ul>
{#if entries || failed}
  <div class="settings-form history">
    {#if failed}
      <Alert variant="critical">{i18n.t('settings.developerPushHistoryFailed')}</Alert>
    {:else if entries && entries.length === 0}
      <Alert variant="info">{i18n.t('settings.developerPushHistoryEmpty')}</Alert>
    {:else if entries}
      <Select
        aria-label={i18n.t('settings.developerPushHistoryFilter')}
        value={filter}
        items={[
          { value: ALL, label: i18n.t('settings.developerPushHistoryAll') },
          ...outcomes.map((outcome) => ({ value: outcome, label: outcome })),
        ]}
        onValueChange={(value) => {
          filter = value;
        }}
      />
      <div class="entries">
        <table>
          <thead>
            <tr>
              <th scope="col">{i18n.t('settings.developerPushOutcome')}</th>
              <th scope="col">{i18n.t('settings.developerPushHistoryTime')}</th>
              <th scope="col">{i18n.t('settings.developerPushHistoryEvent')}</th>
            </tr>
          </thead>
          <tbody>
            {#each shown as entry, index (`${String(entry.at)}-${String(index)}`)}
              <tr>
                <td class="outcome">{entry.outcome}</td>
                <td>
                  <time datetime={new Date(entry.at).toISOString()}>
                    {stamp.format(entry.at)}
                  </time>
                </td>
                <td class="ids">
                  {#each [entry.userId, entry.roomId, entry.eventId].filter(Boolean) as id (id)}
                    <CopyValue value={id as string} />
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
{/if}

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .history {
    gap: var(--space-300);
  }

  .entries {
    max-height: 24rem;
    overflow: auto;
  }

  table {
    border-collapse: collapse;
    width: 100%;
  }

  th,
  td {
    border-top: var(--border-width) solid var(--surface-container-line);
    padding: var(--space-200);
    text-align: start;
    vertical-align: top;
  }

  thead th {
    background: var(--surface-container);
    border-top: 0;
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    position: sticky;
    top: 0;
  }

  .outcome {
    font-family: var(--font-family-mono);
    font-variant-ligatures: none;
    font-weight: var(--font-weight-bold);
  }

  time,
  .ids {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
  }

  td.ids {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-050) var(--space-300);
  }
</style>
