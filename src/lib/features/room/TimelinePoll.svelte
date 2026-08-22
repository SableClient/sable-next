<script lang="ts">
  import type { PollView } from '#src/generated/PollView';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    poll: PollView;
    /** Absent while the poll is a local echo, which cannot be voted on. */
    eventId: string | null;
    canEnd: boolean;
    onVote?: (eventId: string, answers: string[]) => void;
    onEnd?: (eventId: string) => void;
  }

  let { poll, eventId, canEnd, onVote, onEnd }: Props = $props();
  let ended = $derived(poll.ended_at !== null);
  let multiple = $derived(poll.max_selections > 1);
  let selected = $derived(
    poll.answers.filter((answer) => answer.selected).map((answer) => answer.id)
  );
  let total = $derived(poll.answers.reduce((sum, answer) => sum + (answer.votes ?? 0), 0));

  function share(votes: number | null): number {
    if (votes === null || total === 0) return 0;
    return Math.round((votes / total) * 100);
  }

  // MSC3381 has no unvote event: an empty selection is how you withdraw.
  function pick(answerId: string) {
    if (ended || !eventId || !onVote) return;
    if (!multiple) {
      onVote(eventId, selected.includes(answerId) ? [] : [answerId]);
      return;
    }
    if (selected.includes(answerId)) {
      onVote(
        eventId,
        selected.filter((id) => id !== answerId)
      );
      return;
    }
    if (selected.length >= poll.max_selections) return;
    onVote(eventId, [...selected, answerId]);
  }
</script>

<div class="poll">
  <p class="question">
    {poll.question}
    {#if poll.edited}<span class="edited">{$i18n.t('timeline.edited')}</span>{/if}
  </p>

  <ul class="answers">
    {#each poll.answers as answer (answer.id)}
      {@const percent = share(answer.votes)}
      <li>
        <button
          type="button"
          class="answer"
          class:selected={answer.selected}
          aria-pressed={answer.selected}
          disabled={ended || !eventId}
          onclick={() => {
            pick(answer.id);
          }}
        >
          <span class="fill" style:width={`${String(percent)}%`}></span>
          <span class="text">{answer.text}</span>
          {#if answer.votes !== null}
            <span class="count">{$i18n.t('timeline.pollVotes', { count: answer.votes })}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>

  <p class="footer">
    {#if ended}
      {$i18n.t('timeline.pollClosed')}
    {:else if poll.undisclosed}
      {$i18n.t('timeline.pollUndisclosed')}
    {:else}
      {$i18n.t('timeline.pollTotalVotes', { count: total })}
    {/if}
    {#if multiple}
      <span class="hint"
        >{$i18n.t('timeline.pollMaxSelections', { count: poll.max_selections })}</span
      >
    {/if}
  </p>

  {#if !ended && canEnd && eventId && onEnd}
    {@const pollEventId = eventId}
    <button
      type="button"
      class="end"
      onclick={() => {
        onEnd(pollEventId);
      }}
    >
      {$i18n.t('timeline.pollEnd')}
    </button>
  {/if}
</div>

<style>
  .poll {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: var(--timeline-media-max);
    padding: 0.75rem;
  }

  .question {
    font-weight: 600;
    margin: 0;
  }

  .edited {
    color: var(--sable-surface-var-on-container);
    font-size: 0.75rem;
    font-weight: 400;
    margin-inline-start: 0.375rem;
  }

  .answers {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .answer {
    align-items: baseline;
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 0.5rem;
    overflow: hidden;
    padding: 0.5rem 0.625rem;
    position: relative;
    text-align: start;
    width: 100%;
  }

  .answer:disabled {
    cursor: default;
  }

  .answer:not(:disabled):hover {
    border-color: var(--sable-primary-main);
  }

  .answer.selected {
    border-color: var(--sable-primary-main);
  }

  .fill {
    background: var(--sable-primary-container);
    inset-block: 0;
    inset-inline-start: 0;
    position: absolute;
  }

  @media (prefers-reduced-motion: no-preference) {
    .fill {
      transition: width 150ms ease-out;
    }
  }

  .text,
  .count {
    position: relative;
  }

  .text {
    flex: 1;
    overflow-wrap: anywhere;
  }

  .count {
    color: var(--sable-surface-var-on-container);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .footer {
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: 0.8125rem;
    gap: 0.5rem;
    margin: 0;
  }

  .hint::before {
    content: '·';
    margin-inline-end: 0.5rem;
  }

  .end {
    align-self: flex-start;
    background: none;
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-size: 0.8125rem;
    padding: 0.25rem 0.5rem;
  }

  .end:hover {
    border-color: var(--sable-surface-container-line);
    color: var(--sable-surface-on-container);
  }
</style>
