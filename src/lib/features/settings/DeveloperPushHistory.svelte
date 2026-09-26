<script lang="ts">
  import type { PushHistoryEntry } from '#lib/features/notifications/push-history.js';
  import {
    forgetPushHistory,
    loadPushHistory,
  } from '#lib/features/notifications/push-history-source.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const ALL = '*';

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
    title={$i18n.t('settings.developerPushHistoryTitle')}
    description={$i18n.t('settings.developerPushHistoryDescription')}
  >
    <div class="actions">
      <Button variant="secondary" size="small" onclick={() => void load()}>
        {$i18n.t('settings.developerPushHistoryLoad')}
      </Button>
      {#if entries && entries.length > 0}
        <Button variant="secondary" size="small" onclick={() => void clear()}>
          {$i18n.t('settings.developerPushHistoryClear')}
        </Button>
      {/if}
    </div>
  </SettingsRow>
</ul>
{#if entries || failed}
  <div class="settings-form history">
    {#if failed}
      <Alert variant="critical">{$i18n.t('settings.developerPushHistoryFailed')}</Alert>
    {:else if entries && entries.length === 0}
      <Alert variant="info">{$i18n.t('settings.developerPushHistoryEmpty')}</Alert>
    {:else if entries}
      <Select
        aria-label={$i18n.t('settings.developerPushHistoryFilter')}
        value={filter}
        items={[
          { value: ALL, label: $i18n.t('settings.developerPushHistoryAll') },
          ...outcomes.map((outcome) => ({ value: outcome, label: outcome })),
        ]}
        onValueChange={(value) => {
          filter = value;
        }}
      />
      <ol class="entries">
        {#each shown as entry, index (`${String(entry.at)}-${String(index)}`)}
          <li>
            <span class="outcome">{entry.outcome}</span>
            <time datetime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleString()}
            </time>
            {#if entry.roomId || entry.eventId}
              <span class="ids">{[entry.roomId, entry.eventId].filter(Boolean).join(' · ')}</span>
            {/if}
            {#if entry.userId}<span class="ids">{entry.userId}</span>{/if}
          </li>
        {/each}
      </ol>
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
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .entries li {
    display: grid;
    gap: var(--space-050);
  }

  .outcome {
    font-family: var(--font-family-mono);
    font-weight: var(--font-weight-bold);
  }

  time,
  .ids {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
  }

  .ids {
    font-family: var(--font-family-mono);
  }
</style>
