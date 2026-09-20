<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import * as Sentry from '@sentry/sveltekit';
  import {
    type ForgeIssue,
    type ReportType,
    forgeIssueUrl,
    openForgeIssueUrl,
    searchForgeIssues,
  } from '#lib/features/bug-report/forge.js';
  import { i18n } from '#lib/i18n.js';
  import { debugLog, exportDebugLogs } from '#lib/observability/debug-log.svelte.js';
  import { describePlatform } from '#lib/platform/diagnostics.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    onDone: () => void;
  }

  const sentryEnabled = Sentry.isInitialized();
  const version = `v${import.meta.env.VITE_APP_VERSION ?? 'dev'}`;
  const userAgent = typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;

  let { onDone }: Props = $props();
  let platform = $state('unknown');
  let type = $state<ReportType>('bug');
  let title = $state('');
  let description = $state('');
  let reproduction = $state('');
  let expectedBehavior = $state('');
  let problem = $state('');
  let solution = $state('');
  let alternatives = $state('');
  let context = $state('');
  let sendToSentry = $state(true);
  let includeDebugLogs = $state(true);
  let openOnForge = $state(!sentryEnabled);
  let similarIssues = $state<ForgeIssue[]>([]);
  let searching = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchController: AbortController | undefined;
  let canSubmit = $derived(
    title.trim() !== '' &&
      (type === 'bug' ? description.trim() !== '' : problem.trim() !== '' && solution.trim() !== '')
  );

  function scheduleSimilarIssueSearch(value: string): void {
    const query = value.trim();
    searchController?.abort();
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    similarIssues = [];
    searching = query.length >= 3;
    if (query.length < 3) return;

    const controller = new AbortController();
    searchController = controller;
    searchTimer = setTimeout(async () => {
      try {
        const issues = await searchForgeIssues(query, controller.signal);
        if (!controller.signal.aborted) similarIssues = issues;
      } catch {
        return;
      } finally {
        if (!controller.signal.aborted) searching = false;
      }
    }, 600);
  }

  onMount(() => {
    void describePlatform().then((value) => (platform = value));
  });

  onDestroy(() => {
    searchController?.abort();
    if (searchTimer !== undefined) clearTimeout(searchTimer);
  });

  function issueUrl(): string {
    const fields: Record<string, string> =
      type === 'bug'
        ? {
            description,
            reproduction,
            'expected-behavior': expectedBehavior,
            info: `- OS: ${platform}\n- Browser: ${userAgent}\n- Sable: ${version}`,
            context,
          }
        : { problem, solution, alternatives, context };
    return forgeIssueUrl(type, title, fields);
  }

  function submit(): void {
    if (!canSubmit) return;

    if (sendToSentry && type === 'bug') {
      const sentryMessage = [
        `[Bug Report] ${title.trim()}`,
        '',
        `Description:\n${description}`,
        reproduction ? `\nSteps to Reproduce:\n${reproduction}` : '',
        expectedBehavior ? `\nExpected Behavior:\n${expectedBehavior}` : '',
        context ? `\nAdditional Context:\n${context}` : '',
        `\nEnvironment: ${version} - ${platform}`,
      ]
        .filter(Boolean)
        .join('\n');
      const eventId = Sentry.captureMessage(sentryMessage, {
        level: 'info',
        fingerprint: ['bug-report-page'],
        tags: { source: 'bug-report-page', reportType: type },
        extra: {
          title: title.trim(),
          description,
          reproduction: reproduction || '(not provided)',
          expectedBehavior: expectedBehavior || '(not provided)',
          context: context || '(not provided)',
          userAgent,
          platform,
          version,
          ...(includeDebugLogs ? { debugLogs: exportDebugLogs(debugLog.entries.slice(-100)) } : {}),
        },
      });
      if (eventId) {
        Sentry.captureFeedback({
          message: sentryMessage,
          name: 'User Bug Report',
          associatedEventId: eventId,
        });
      }
    }

    if (type === 'feature' || !sentryEnabled || openOnForge) {
      void openForgeIssueUrl(issueUrl());
    }
    onDone();
  }
</script>

<form
  class="bug-report"
  onsubmit={(event) => {
    event.preventDefault();
    submit();
  }}
>
  <fieldset>
    <legend>{$i18n.t('bugReport.type')}</legend>
    <Select
      aria-label={$i18n.t('bugReport.type')}
      value={type}
      items={[
        { value: 'bug', label: $i18n.t('bugReport.bug') },
        { value: 'feature', label: $i18n.t('bugReport.feature') },
      ]}
      onValueChange={(value) => (type = value as ReportType)}
    />
  </fieldset>

  <div class="field">
    <Label for="bug-report-title">{$i18n.t('bugReport.title')}</Label>
    <TextInput
      id="bug-report-title"
      bind:value={title}
      oninput={(event) =>
        scheduleSimilarIssueSearch((event.currentTarget as HTMLInputElement).value)}
      placeholder={$i18n.t('bugReport.titlePlaceholder')}
      autocomplete="off"
    />
  </div>

  {#if searching}
    <p class="search-status"><Spinner small /> {$i18n.t('bugReport.searching')}</p>
  {:else if similarIssues.length > 0}
    <div class="similar" role="status">
      <p>{$i18n.t('bugReport.similarIssues')}</p>
      {#each similarIssues as issue (issue.number)}
        <a href={issue.html_url} target="_blank" rel="noopener noreferrer"
          >#{issue.number}: {issue.title}</a
        >
      {/each}
    </div>
  {/if}

  {#if type === 'bug'}
    <div class="field">
      <Label for="bug-report-description">{$i18n.t('bugReport.description')}</Label>
      <TextArea
        id="bug-report-description"
        bind:value={description}
        rows={4}
        placeholder={$i18n.t('bugReport.descriptionPlaceholder')}
      />
    </div>
    <div class="field">
      <Label for="bug-report-reproduction">{$i18n.t('bugReport.reproduction')}</Label>
      <TextArea
        id="bug-report-reproduction"
        bind:value={reproduction}
        rows={3}
        placeholder={$i18n.t('bugReport.reproductionPlaceholder')}
      />
    </div>
    <div class="field">
      <Label for="bug-report-expected">{$i18n.t('bugReport.expectedBehavior')}</Label>
      <TextArea id="bug-report-expected" bind:value={expectedBehavior} rows={2} />
    </div>
    <p class="platform">{$i18n.t('bugReport.platformInfo')}: {version} / {platform}</p>
  {:else}
    <div class="field">
      <Label for="bug-report-problem">{$i18n.t('bugReport.problem')}</Label>
      <TextArea id="bug-report-problem" bind:value={problem} rows={4} />
    </div>
    <div class="field">
      <Label for="bug-report-solution">{$i18n.t('bugReport.solution')}</Label>
      <TextArea id="bug-report-solution" bind:value={solution} rows={3} />
    </div>
    <div class="field">
      <Label for="bug-report-alternatives">{$i18n.t('bugReport.alternatives')}</Label>
      <TextArea id="bug-report-alternatives" bind:value={alternatives} rows={2} />
    </div>
  {/if}

  <div class="field">
    <Label for="bug-report-context">{$i18n.t('bugReport.context')}</Label>
    <TextArea id="bug-report-context" bind:value={context} rows={2} />
  </div>

  {#if type === 'bug' && sentryEnabled}
    <fieldset class="options">
      <legend>{$i18n.t('bugReport.errorTracking')}</legend>
      <label class="option">
        <input type="checkbox" bind:checked={sendToSentry} />
        {$i18n.t('bugReport.sendToSentry')}
      </label>
      {#if sendToSentry}
        <label class="option">
          <input type="checkbox" bind:checked={includeDebugLogs} />
          {$i18n.t('bugReport.includeDebugLogs')}
        </label>
      {/if}
      <label class="option">
        <input type="checkbox" bind:checked={openOnForge} />
        {$i18n.t('bugReport.openOnForge')}
      </label>
    </fieldset>
  {/if}

  <div class="actions">
    <Button variant="ghost" onclick={onDone}>{$i18n.t('bugReport.cancel')}</Button>
    <Button type="submit" variant="primary" disabled={!canSubmit}>
      {$i18n.t(
        type === 'bug' && sentryEnabled ? 'bugReport.submit' : 'bugReport.openOnForgeAction'
      )}
    </Button>
  </div>
</form>

<style>
  .bug-report {
    display: grid;
    gap: var(--space-500);
  }

  fieldset {
    border: 0;
    display: grid;
    gap: var(--space-300);
    margin: 0;
    padding: 0;
  }

  legend {
    font-weight: var(--font-weight-bold);
    margin-bottom: var(--space-200);
  }

  .field {
    display: grid;
    gap: var(--space-200);
  }

  .field :global(.form-control) {
    width: 100%;
  }

  .search-status,
  .platform,
  .similar p {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .search-status {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .similar {
    background: var(--primary-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-200);
    padding: var(--space-300) var(--space-400);
  }

  .similar a {
    overflow-wrap: anywhere;
  }

  .options {
    gap: var(--space-300);
  }

  .option {
    align-items: flex-start;
    display: flex;
    gap: var(--space-300);
  }

  .option input {
    accent-color: var(--primary-main);
    flex: 0 0 auto;
    margin: var(--space-100) 0 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
