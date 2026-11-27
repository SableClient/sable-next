<script lang="ts">
  import { copyText } from '#lib/platform/clipboard.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import SearchField from '#lib/ui/primitives/SearchField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import {
    clearDebugLogs,
    DEBUG_LOG_CATEGORIES,
    debugLog,
    exportDebugLogs,
    setDebugLogging,
    type DebugLogCategory,
    type DebugLogLevel,
  } from '#lib/observability/debug-log.svelte.js';
  import { exportDiagnosticsBundle } from '#lib/observability/export-diagnostics.js';
  import '#lib/ui/primitives/settings-row.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import { reportSave } from '#lib/ui/download.js';

  const levels: (DebugLogLevel | 'all')[] = ['all', 'debug', 'info', 'warn', 'error'];
  let level = $state<DebugLogLevel | 'all'>('all');
  let category = $state<DebugLogCategory | 'all'>('all');
  let query = $state('');
  let filtered = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    return debugLog.entries.filter(
      (entry) =>
        (level === 'all' || entry.level === level) &&
        (category === 'all' || entry.category === category) &&
        (!needle ||
          entry.message.toLocaleLowerCase().includes(needle) ||
          entry.namespace.toLocaleLowerCase().includes(needle))
    );
  });
  const SHOWN = 500;
  let shown = $derived(filtered.slice(-SHOWN).reverse());

  const clock = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  });

  async function download(entries = filtered): Promise<void> {
    reportSave(await exportDiagnosticsBundle(entries));
  }

  async function copy(entries = filtered): Promise<void> {
    await copyText(exportDebugLogs(entries));
  }
</script>

<div class="logs">
  <ul class="settings">
    <SettingsRow
      id="debug-logs-status"
      title={i18n.t('settings.developerLogsStatus')}
      description={i18n.t('settings.developerLogsDescription')}
    >
      <Switch
        label={i18n.t('settings.developerLogsEnable')}
        checked={debugLog.enabled}
        onCheckedChange={setDebugLogging}
      />
    </SettingsRow>
  </ul>

  <div class="settings-form logs-body">
    <div class="toolbar">
      <div class="search">
        <SearchField bind:value={query} label={i18n.t('settings.developerLogsSearch')} />
      </div>
      <FormField fieldId="debug-logs-level" label={i18n.t('settings.developerLogsLevel')}>
        <Select
          id="debug-logs-level"
          value={level}
          items={levels.map((value) => ({
            value,
            label: i18n.t(`settings.developerLogLevels.${value}`),
          }))}
          onValueChange={(value) => (level = value as DebugLogLevel | 'all')}
        />
      </FormField>
      <FormField fieldId="debug-logs-category" label={i18n.t('settings.developerLogsCategory')}>
        <Select
          id="debug-logs-category"
          value={category}
          items={[
            { value: 'all', label: i18n.t('settings.developerLogCategories.all') },
            ...DEBUG_LOG_CATEGORIES.map((value) => ({
              value,
              label: i18n.t(`settings.developerLogCategories.${value}`),
            })),
          ]}
          onValueChange={(value) => (category = value as DebugLogCategory | 'all')}
        />
      </FormField>
    </div>

    <div class="summary-bar">
      <p class="count">
        {i18n.t('settings.developerLogsShowing', {
          shown: shown.length,
          total: debugLog.entries.length,
        })}
      </p>
      <div class="actions">
        <Button variant="ghost" size="small" onclick={clearDebugLogs}>
          {i18n.t('common.clear')}
        </Button>
        <Button variant="secondary" size="small" onclick={() => void copy()}>
          {i18n.t('settings.developerLogsCopy')}
        </Button>
        <Button variant="secondary" size="small" onclick={() => void download()}>
          {i18n.t('settings.developerLogsExport')}
        </Button>
      </div>
    </div>

    {#if shown.length === 0}
      <p class="empty-text">
        {i18n.t(debugLog.enabled ? 'settings.developerLogsEmpty' : 'settings.developerLogsOff')}
      </p>
    {:else}
      <ol class="console" {@attach scrollHint}>
        {#each shown as entry (entry.id)}
          <li class={`level-${entry.level}`}>
            <details>
              <summary>
                <time datetime={new Date(entry.timestamp).toISOString()}>
                  {clock.format(entry.timestamp)}
                </time>
                <span class="level">{entry.level}</span>
                <span class="category">{entry.category}</span>
                <span class="message">{entry.message}</span>
              </summary>
              <div class="detail">
                <p class="namespace">{entry.namespace}</p>
                <p class="full">{entry.message}</p>
                {#if entry.data}<pre>{JSON.stringify(entry.data, null, 2)}</pre>{/if}
              </div>
            </details>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</div>

<style>
  .logs {
    display: grid;
  }

  .logs-body {
    display: grid;
    gap: var(--space-300);
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .toolbar {
    align-items: end;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: minmax(12rem, 1fr) minmax(8rem, 10rem) minmax(8rem, 12rem);
  }

  .search {
    align-self: end;
  }

  @media (width < 40rem) {
    .toolbar {
      grid-template-columns: 1fr 1fr;
    }

    .search {
      grid-column: 1 / -1;
    }
  }

  .summary-bar {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    justify-content: space-between;
  }

  .count {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .empty-text {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .console {
    background: var(--bg-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--bg-on-container);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    font-variant-ligatures: none;
    font-variant-numeric: tabular-nums;
    list-style: none;
    margin: 0;
    max-height: 36rem;
    overflow: auto;
    padding: 0;
  }

  .console li + li {
    border-top: var(--border-width) solid var(--bg-container-line);
  }

  summary {
    align-items: baseline;
    cursor: pointer;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: auto 3.5rem 6rem minmax(0, 1fr);
    list-style: none;
    padding: var(--space-150) var(--space-300);
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:hover {
    background: var(--bg-container-hover);
  }

  summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  time,
  .category,
  .namespace {
    color: var(--surface-var-on-container);
  }

  .level {
    font-weight: var(--font-weight-medium);
    text-transform: uppercase;
  }

  .message {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .level-error .level,
  .level-error .message {
    color: var(--crit-main);
  }

  .level-warn .level {
    color: var(--warn-main);
  }

  .level-debug .level {
    color: var(--surface-var-on-container);
  }

  .category {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  details[open] .message {
    visibility: hidden;
  }

  .detail {
    display: grid;
    gap: var(--space-200);
    padding: 0 var(--space-300) var(--space-300);
  }

  .detail p,
  pre {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  pre {
    background: var(--surface-container);
    border-radius: var(--radius-inner);
    max-height: 16rem;
    overflow: auto;
    padding: var(--space-200) var(--space-300);
  }

  @media (width < 40rem) {
    summary {
      grid-template-columns: auto 3rem minmax(0, 1fr);
    }

    .category {
      display: none;
    }
  }
</style>
