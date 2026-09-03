<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import type { PollView } from '#src/generated/PollView';

  import { i18n } from '#lib/i18n.js';

  import PollVotersDialog from './PollVotersDialog.svelte';

  interface Props {
    poll: PollView;
    /** Absent while the poll is a local echo, which cannot be voted on. */
    eventId: string | null;
    canEnd: boolean;
    members?: readonly MemberView[];
    onVote?: (eventId: string, answers: string[]) => void;
    onEnd?: (eventId: string) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { poll, eventId, canEnd, members = [], onVote, onEnd, onSenderProfile }: Props = $props();
  let ended = $derived(poll.ended_at !== null);
  let multiple = $derived(poll.max_selections > 1);
  let selected = $derived(
    poll.answers.filter((answer) => answer.selected).map((answer) => answer.id)
  );
  let total = $derived(poll.answers.reduce((sum, answer) => sum + (answer.votes ?? 0), 0));
  let votersAnswers = $derived(poll.answers.filter((answer) => answer.voters !== null));
  let votersOpen = $state(false);
  let votersActive = $state(0);

  function viewVoters(answerId: string) {
    const index = votersAnswers.findIndex((answer) => answer.id === answerId);
    if (index === -1) return;
    votersActive = index;
    votersOpen = true;
  }

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
      <li class="answer-row">
        <button
          type="button"
          class="answer sable-choice"
          aria-pressed={answer.selected}
          disabled={ended || !eventId}
          onclick={() => {
            pick(answer.id);
          }}
        >
          <span class="fill" style:width={`${String(percent)}%`}></span>
          <span class="text">{answer.text}</span>
        </button>
        {#if answer.votes !== null}
          {#if answer.voters !== null}
            <button
              type="button"
              class="count count-button"
              onclick={() => {
                viewVoters(answer.id);
              }}
              aria-label={$i18n.t('timeline.pollViewVoters', { answer: answer.text })}
            >
              {$i18n.t('timeline.pollVotes', { count: answer.votes })}
            </button>
          {:else}
            <span class="count">{$i18n.t('timeline.pollVotes', { count: answer.votes })}</span>
          {/if}
        {/if}
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

{#if votersOpen}
  <PollVotersDialog
    bind:open={votersOpen}
    answers={votersAnswers}
    {members}
    bind:active={votersActive}
    onMemberProfile={onSenderProfile}
  />
{/if}

<style>
  .poll {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: var(--space-150);
    max-width: var(--timeline-media-max);
    padding: var(--space-300);
  }

  .question {
    font-weight: var(--font-weight-medium);
    margin: 0;
  }

  .edited {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-normal);
    margin-inline-start: var(--space-150);
  }

  .answers {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .answer-row {
    align-items: center;
    display: flex;
    gap: var(--space-100);
  }

  .answer {
    align-items: baseline;
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    gap: var(--space-200);
    min-width: 0;
    overflow: hidden;
    padding: var(--space-200) var(--space-250);
    position: relative;
    text-align: start;
  }

  .answer:disabled {
    cursor: default;
  }

  .answer:not(:disabled, [aria-pressed='true']):hover {
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
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .count-button {
    background: none;
    border: none;
    cursor: pointer;
    min-height: 2.75rem;
    padding: var(--space-100);
  }

  .count-button:hover {
    color: var(--sable-surface-on-container);
    text-decoration: underline;
  }

  .footer {
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin: 0;
  }

  .hint::before {
    content: '·';
    margin-inline-end: var(--space-200);
  }

  .end {
    align-self: flex-start;
    background: none;
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    padding: var(--space-100) var(--space-200);
  }

  .end:hover {
    border-color: var(--sable-surface-container-line);
    color: var(--sable-surface-on-container);
  }
</style>
