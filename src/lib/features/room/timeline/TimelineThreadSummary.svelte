<script lang="ts">
  import ThreadIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';

  import type { PerMessageProfileView, ThreadSummaryView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { fallbackText } from '../messages/reply-fallback.js';
  import { stripReplyFallback } from '../members/members.js';

  interface Props {
    summary: ThreadSummaryView | null;
    persona?: PerMessageProfileView | null;
    onOpen: () => void;
  }

  let { summary, persona = null, onOpen }: Props = $props();
</script>

<button type="button" class="thread-summary" onclick={onOpen}>
  <ThreadIcon size={14} aria-hidden="true" />
  {#if summary}
    <span class="thread-count"
      >{i18n.t('timeline.threadReplies', { count: summary.num_replies })}</span
    >
    {@const latest = stripReplyFallback(
      fallbackText(summary.latest_body, summary.latest_fallback, i18n.t),
      persona
    )}
    {#if latest}
      <span class="thread-latest"><bdi>{latest}</bdi></span>
    {/if}
  {:else}
    <span class="thread-count">{i18n.t('timeline.thread')}</span>
  {/if}
</button>

<style>
  .thread-summary {
    align-items: center;
    background: none;
    border: none;
    color: var(--primary-main);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin-top: var(--space-050);
    max-width: 100%;
    padding: 0;
    text-align: start;
  }

  .thread-count {
    flex: none;
    font-weight: var(--font-weight-medium);
  }

  .thread-summary:hover .thread-count {
    text-decoration: underline;
  }

  .thread-latest {
    color: var(--surface-var-on-container);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
