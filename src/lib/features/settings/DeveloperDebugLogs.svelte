<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import BugIcon from 'phosphor-svelte/lib/BugIcon';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import {
    clearDebugLogs,
    debugLog,
    exportDebugLogs,
    setDebugLogging,
    type DebugLogCategory,
    type DebugLogLevel,
  } from '#lib/observability/debug-log.svelte.js';

  const categories: DebugLogCategory[] = [
    'sync',
    'network',
    'notification',
    'message',
    'media',
    'call',
    'ui',
    'timeline',
    'error',
    'general',
  ];
  const levels: (DebugLogLevel | 'all')[] = ['all', 'debug', 'info', 'warn', 'error'];
  let level = $state<DebugLogLevel | 'all'>('all');
  let category = $state<DebugLogCategory | 'all'>('all');
  let filtered = $derived(
    debugLog.entries.filter(
      (entry) =>
        (level === 'all' || entry.level === level) &&
        (category === 'all' || entry.category === category)
    )
  );

  function download(entries = filtered): void {
    const url = URL.createObjectURL(
      new Blob([exportDebugLogs(entries)], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `sable-debug-logs-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copy(entries = filtered): Promise<void> {
    await navigator.clipboard.writeText(exportDebugLogs(entries));
  }
</script>

<div class="logs">
  <ul class="settings">
    <SettingsRow
      title={$i18n.t('settings.developerLogsStatus')}
      description={$i18n.t('settings.developerLogsDescription')}
      icon={BugIcon}
    >
      <Switch
        label={$i18n.t('settings.developerLogsEnable')}
        checked={debugLog.enabled}
        onCheckedChange={setDebugLogging}
      />
    </SettingsRow>
  </ul>

  <div class="filters">
    <Select
      aria-label={$i18n.t('settings.developerLogsLevel')}
      value={level}
      items={levels.map((value) => ({ value, label: value }))}
      onValueChange={(value) => (level = value as DebugLogLevel | 'all')}
    />
    <Select
      aria-label={$i18n.t('settings.developerLogsCategory')}
      value={category}
      items={[
        { value: 'all', label: 'all' },
        ...categories.map((value) => ({ value, label: value })),
      ]}
      onValueChange={(value) => (category = value as DebugLogCategory | 'all')}
    />
  </div>

  <div class="actions">
    <Button variant="ghost" size="small" onclick={clearDebugLogs}
      >{$i18n.t('settings.developerLogsClear')}</Button
    >
    <Button variant="secondary" size="small" onclick={() => void copy()}
      >{$i18n.t('settings.developerLogsCopy')}</Button
    >
    <Button variant="secondary" size="small" onclick={() => download()}
      >{$i18n.t('settings.developerLogsExport')}</Button
    >
  </div>

  {#if filtered.length === 0}
    <p class="empty">{$i18n.t('settings.developerLogsEmpty')}</p>
  {:else}
    <div class="entries" aria-live="polite">
      {#each filtered.slice(-200).toReversed() as entry (entry.id)}
        <details class={`entry level-${entry.level}`}>
          <summary>
            <span>{entry.level.toUpperCase()}</span>
            <span>{entry.category}</span>
            <time datetime={new Date(entry.timestamp).toISOString()}
              >{new Date(entry.timestamp).toLocaleTimeString()}</time
            >
            <span>{entry.namespace}</span>
          </summary>
          <p>{entry.message}</p>
          {#if entry.data}<pre>{JSON.stringify(entry.data, null, 2)}</pre>{/if}
        </details>
      {/each}
    </div>
  {/if}
</div>

<style>
  .logs,
  .entries {
    display: grid;
    gap: var(--space-2);
  }

  .logs > :not(.settings) {
    margin-inline: var(--space-3);
  }

  .filters,
  .actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  p {
    margin: 0;
  }

  p,
  .empty {
    color: var(--sable-surface-var-on-container);
  }

  .filters > :global(*) {
    min-width: 9rem;
  }

  .actions {
    justify-content: flex-end;
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .entries {
    max-height: 32rem;
    overflow: auto;
  }

  .entry {
    background: var(--sable-bg-container);
    border-radius: var(--radius);
    padding: var(--space-1) var(--space-2);
  }

  summary {
    cursor: pointer;
    display: grid;
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    gap: var(--space-1);
    grid-template-columns: auto auto auto 1fr;
  }

  summary span:first-child {
    font-weight: var(--font-weight-bold);
  }

  .level-error summary span:first-child {
    color: var(--sable-crit-main);
  }

  .level-warn summary span:first-child {
    color: var(--sable-warn-main);
  }

  .entry p,
  pre {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    margin: var(--space-1) 0 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  pre {
    max-height: 12rem;
    overflow: auto;
  }
</style>
