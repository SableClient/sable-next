<script lang="ts">
  import type { SearchCrawlPhase, SearchMetricsView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const REFRESH_MS = 2000;

  const core = useCoreClient();
  let metrics = $state<SearchMetricsView | null>(null);
  let unavailable = $state(false);

  $effect(() => {
    if (core.session?.account_id === undefined) {
      metrics = null;
      return;
    }

    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const next = await core.commands.searchMetrics();
        if (!active) return;
        metrics = next;
        unavailable = false;
      } catch {
        if (active) unavailable = true;
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  });

  const phaseKeys: Record<SearchCrawlPhase, string> = {
    starting: 'settings.developerSearchPhaseStarting',
    crawling: 'settings.developerSearchPhaseCrawling',
    yielding: 'settings.developerSearchPhaseYielding',
    backing_off: 'settings.developerSearchPhaseBackingOff',
    idle: 'settings.developerSearchPhaseIdle',
    budget_spent: 'settings.developerSearchPhaseBudgetSpent',
    index_full: 'settings.developerSearchPhaseIndexFull',
  };

  let phaseVariant: 'success' | 'critical' | 'warning' = $derived(
    metrics?.phase === 'crawling' || metrics?.phase === 'idle'
      ? 'success'
      : metrics?.phase === 'backing_off'
        ? 'critical'
        : 'warning'
  );

  let eventsPerMinute = $derived(
    metrics?.running_ms ? Math.round((metrics.events_crawled * 60_000) / metrics.running_ms) : 0
  );

  function count(value: number): string {
    return $i18n.t('settings.developerSearchCount', { count: value });
  }

  function ratio(value: number, total: number): string {
    return $i18n.t('settings.developerSearchRatio', { value, total });
  }

  function milliseconds(value: number | null): string {
    return value === null ? '-' : $i18n.t('settings.developerSearchMilliseconds', { count: value });
  }

  function minutes(value: number | null): string {
    return value === null
      ? '-'
      : $i18n.t('settings.developerSearchMinutes', { count: Math.floor(value / 60_000) });
  }
</script>

<div class="diagnostics">
  {#if metrics}
    <ul class="settings">
      <SettingsRow id="search-phase" title={$i18n.t('settings.developerSearchPhase')}>
        <StatusBadge label={$i18n.t(phaseKeys[metrics.phase])} variant={phaseVariant} />
      </SettingsRow>
      <SettingsRow id="search-documents" title={$i18n.t('settings.developerSearchDocuments')}>
        <code>{ratio(metrics.documents, metrics.capacity)}</code>
      </SettingsRow>
      <SettingsRow id="search-events" title={$i18n.t('settings.developerSearchEvents')}>
        <code>{ratio(metrics.events_crawled, metrics.event_budget)}</code>
      </SettingsRow>
      <SettingsRow id="search-rate" title={$i18n.t('settings.developerSearchRate')}>
        <code>{$i18n.t('settings.developerSearchRateValue', { count: eventsPerMinute })}</code>
      </SettingsRow>
      <SettingsRow id="search-running" title={$i18n.t('settings.developerSearchRunning')}>
        <code>{minutes(metrics.running_ms)}</code>
      </SettingsRow>
      <SettingsRow id="search-batches" title={$i18n.t('settings.developerSearchBatches')}>
        <code>{count(metrics.batches)}</code>
      </SettingsRow>
      <SettingsRow id="search-pushbacks" title={$i18n.t('settings.developerSearchPushbacks')}>
        <code>{count(metrics.pushbacks)}</code>
      </SettingsRow>
      <SettingsRow id="search-request-last" title={$i18n.t('settings.developerSearchRequestLast')}>
        <code>{milliseconds(metrics.last_request_ms)}</code>
      </SettingsRow>
      <SettingsRow
        id="search-request-average"
        title={$i18n.t('settings.developerSearchRequestAverage')}
      >
        <code>{milliseconds(metrics.average_request_ms)}</code>
      </SettingsRow>
      <SettingsRow
        id="search-rooms-indexed"
        title={$i18n.t('settings.developerSearchRoomsIndexed')}
      >
        <code>{ratio(metrics.rooms_indexed, metrics.rooms_joined)}</code>
      </SettingsRow>
      <SettingsRow
        id="search-rooms-pending"
        title={$i18n.t('settings.developerSearchRoomsPending')}
      >
        <code>{count(metrics.rooms_pending)}</code>
      </SettingsRow>
      <SettingsRow
        id="search-rooms-exhausted"
        title={$i18n.t('settings.developerSearchRoomsExhausted')}
      >
        <code>{count(metrics.rooms_exhausted)}</code>
      </SettingsRow>
      <SettingsRow id="search-rooms-failed" title={$i18n.t('settings.developerSearchRoomsFailed')}>
        <code>{count(metrics.rooms_failed)}</code>
      </SettingsRow>
      <SettingsRow id="search-rooms-blind" title={$i18n.t('settings.developerSearchRoomsBlind')}>
        <code>{count(metrics.rooms_blind)}</code>
      </SettingsRow>
      <SettingsRow
        id="search-rooms-unreadable"
        title={$i18n.t('settings.developerSearchRoomsUnreadable')}
      >
        <code>{count(metrics.rooms_unreadable)}</code>
      </SettingsRow>
    </ul>
  {:else if unavailable}
    <p class="error">{$i18n.t('settings.developerSearchUnavailable')}</p>
  {/if}
</div>

<style>
  .diagnostics {
    display: grid;
  }

  .settings {
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  code {
    font-family: var(--font-family-mono);
    overflow-wrap: anywhere;
    text-align: right;
  }

  .error {
    color: var(--crit-main);
    margin: 0;
  }
</style>
