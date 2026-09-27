<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  import { stateContentDiff, stateValueText } from './state-content-diff';

  const LIMIT = 6;

  interface Props {
    before: unknown;
    after: unknown;
  }

  let { before, after }: Props = $props();
  let expanded = $state(false);
  let changes = $derived(stateContentDiff(before, after));
  let shown = $derived(expanded ? changes : changes.slice(0, LIMIT));
</script>

<div class="state-diff">
  {#if changes.length === 0}
    <p class="unchanged">{$i18n.t('timeline.stateUnchanged')}</p>
  {:else}
    <ul>
      {#each shown as change (change.path.join('\u0000'))}
        <li>
          <code class="path">{change.path.join(' › ')}</code>
          {#if change.before !== undefined}<del>{stateValueText(change.before)}</del>{/if}
          {#if change.before !== undefined && change.after !== undefined}<span
              class="arrow"
              aria-hidden="true">→</span
            >{/if}
          {#if change.after !== undefined}<ins>{stateValueText(change.after)}</ins>{/if}
        </li>
      {/each}
    </ul>
    {#if changes.length > LIMIT}
      <button
        class="more"
        type="button"
        onclick={() => {
          expanded = !expanded;
        }}
      >
        {expanded
          ? $i18n.t('timeline.stateChangesLess')
          : $i18n.t('timeline.stateChangesMore', { count: changes.length - LIMIT })}
      </button>
    {/if}
  {/if}
</div>

<style>
  .state-diff {
    color: var(--surface-var-on-container);
    display: grid;
    font-size: var(--font-size-small);
    gap: var(--space-050);
    justify-items: start;
    line-height: 1.4;
    min-width: 0;
  }

  ul,
  .unchanged {
    margin: 0;
    padding: 0;
  }

  ul {
    display: grid;
    gap: var(--space-050);
    list-style: none;
  }

  li {
    overflow-wrap: anywhere;
  }

  code,
  del,
  ins {
    font-family: var(--font-family-mono);
  }

  .path {
    margin-inline-end: var(--space-200);
  }

  del {
    color: var(--crit-main);
  }

  ins {
    color: var(--success-main);
    text-decoration: none;
  }

  .arrow {
    margin-inline: var(--space-100);
  }

  .more {
    background: none;
    border: 0;
    color: var(--primary-main);
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
