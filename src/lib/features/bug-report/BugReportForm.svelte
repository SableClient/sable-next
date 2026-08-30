<script lang="ts">
  import { onDestroy } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import * as Sentry from '@sentry/sveltekit';
  import { i18n } from '#lib/i18n.js';
  import { debugLog, exportDebugLogs } from '#lib/observability/debug-log.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  type ReportType = 'bug' | 'feature';

  type SimilarIssue = {
    number: number;
    title: string;
    html_url: string;
  };

  interface Props {
    onDone: () => void;
  }

  const GITHUB_REPO = 'SableClient/Sable';
  const sentryEnabled = Sentry.isInitialized();
  const version = `v${import.meta.env.VITE_APP_VERSION ?? 'dev'}`;
  const platform = typeof navigator === 'undefined' ? 'unknown' : navigator.platform || 'unknown';
  const userAgent = typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;

  let { onDone }: Props = $props();
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
  let openOnGitHub = $state(!sentryEnabled);
  let similarIssues = $state<SimilarIssue[]>([]);
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
      const words = query
        .split(/[\s\-_/]+/)
        .map((word) => word.replace(/[^\w]/g, ''))
        .filter((word) => word.length >= 3);
      if (words.length === 0) {
        searching = false;
        return;
      }

      try {
        const params = new globalThis.URLSearchParams({
          q: `${words.join(' OR ')} repo:${GITHUB_REPO} is:issue is:open`,
          per_page: '5',
        });
        const response = await fetch(`https://api.github.com/search/issues?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok || controller.signal.aborted) return;
        const data = (await response.json()) as { items?: SimilarIssue[] };
        similarIssues = data.items ?? [];
      } catch {
        return;
      } finally {
        if (!controller.signal.aborted) searching = false;
      }
    }, 600);
  }

  onDestroy(() => {
    searchController?.abort();
    if (searchTimer !== undefined) clearTimeout(searchTimer);
  });

  function githubUrl(fields: Record<string, string>): string {
    const params = new SvelteURLSearchParams({
      title: title.trim(),
      template: `${type === 'bug' ? 'bug_report' : 'feature_request'}.yml`,
    });
    if (type === 'bug') {
      if (fields.description) params.set('description', fields.description);
      if (fields.reproduction) params.set('reproduction', fields.reproduction);
      if (fields.expectedBehavior) params.set('expected-behavior', fields.expectedBehavior);
      params.set('info', `- OS: ${platform}\n- Browser: ${userAgent}\n- Sable: ${version}`);
      if (fields.context) params.set('context', fields.context);
    } else {
      if (fields.problem) params.set('problem', fields.problem);
      if (fields.solution) params.set('solution', fields.solution);
      if (fields.alternatives) params.set('alternatives', fields.alternatives);
      if (fields.context) params.set('context', fields.context);
    }
    return `https://github.com/${GITHUB_REPO}/issues/new?${params}`;
  }

  function submit(): void {
    if (!canSubmit) return;

    const fields = {
      description,
      reproduction,
      expectedBehavior,
      problem,
      solution,
      alternatives,
      context,
    };
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

    if (type === 'feature' || !sentryEnabled || openOnGitHub) {
      window.open(githubUrl(fields), '_blank', 'noopener,noreferrer');
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
        <input type="checkbox" bind:checked={openOnGitHub} />
        {$i18n.t('bugReport.openOnGitHub')}
      </label>
    </fieldset>
  {/if}

  <div class="actions">
    <Button variant="ghost" onclick={onDone}>{$i18n.t('bugReport.cancel')}</Button>
    <Button type="submit" variant="primary" disabled={!canSubmit}>
      {$i18n.t(
        type === 'bug' && sentryEnabled ? 'bugReport.submit' : 'bugReport.openOnGitHubAction'
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
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .search-status {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .similar {
    background: var(--sable-primary-container);
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
    accent-color: var(--sable-primary-main);
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
