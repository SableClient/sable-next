<script lang="ts">
  import { Collapsible } from 'bits-ui';
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { i18n } from '#lib/i18n.js';

  import { stateEventText } from './state-event-text';
  import { FOLD_SUMMARY_COUNT } from './timeline-format';

  interface Props {
    run: readonly TimelineItemView[];
  }

  let { run }: Props = $props();
  let expanded = $state(false);
  let summary = $derived(
    run
      .slice(0, FOLD_SUMMARY_COUNT)
      .map((entry) => stateEventText(entry, $i18n.t))
      .join(' · ')
  );
  let hiddenCount = $derived(run.length - FOLD_SUMMARY_COUNT);
</script>

<Collapsible.Root bind:open={expanded}>
  <p class="state">
    <span class="state-rail" aria-hidden="true"></span>
    {#if !expanded}<span class="summary">{summary}</span>{/if}
    <Collapsible.Trigger class="state-more">
      {expanded
        ? $i18n.t('timeline.foldShowLess')
        : $i18n.t('timeline.foldMore', { count: hiddenCount })}
    </Collapsible.Trigger>
  </p>
  <Collapsible.Content>
    {#each run as entry (entry.id)}
      <p class="state">
        <span class="state-rail" aria-hidden="true"></span>
        {stateEventText(entry, $i18n.t)}
      </p>
    {/each}
  </Collapsible.Content>
</Collapsible.Root>

<style>
  .state {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    line-height: 1.3;
    margin: 0;
    padding: 0;
  }

  .state-rail {
    border-top: var(--border-width) dashed var(--sable-surface-var-container-line);
    flex: 0 0 calc(var(--avatar-size-small) - 0.75rem);
    margin-inline-start: 0.75rem;
  }

  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state :global(.state-more) {
    background: none;
    border: none;
    color: var(--sable-primary-main);
    cursor: pointer;
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    min-height: var(--control-height-small);
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .state :global(.state-more):hover {
    color: var(--sable-primary-main-hover);
  }

  .state :global(.state-more):active {
    color: var(--sable-primary-main-active);
  }
</style>
