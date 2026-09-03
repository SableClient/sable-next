<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import type { PollAnswerView } from '#src/generated/PollAnswerView';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import MemberIdentityRow from './MemberIdentityRow.svelte';

  interface Props {
    open?: boolean;
    answers: readonly PollAnswerView[];
    members: readonly MemberView[];
    active?: number;
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    open = $bindable(false),
    answers,
    members,
    active = $bindable(0),
    onMemberProfile,
  }: Props = $props();
  let answer = $derived<PollAnswerView | undefined>(answers[Math.min(active, answers.length - 1)]);
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.pollVoters')}>
  <div class="voters-dialog">
    <h2>{$i18n.t('timeline.pollVoters')}</h2>
    <div class="tabs" role="tablist" aria-label={$i18n.t('timeline.pollVoters')}>
      {#each answers as tab, index (tab.id)}
        <Button
          size="small"
          variant="ghost"
          class="tab sable-choice"
          role="tab"
          aria-selected={tab.id === answer?.id}
          onclick={() => {
            active = index;
          }}
        >
          <em>{tab.text}</em>
          {tab.voters?.length ?? 0}
        </Button>
      {/each}
    </div>
    {#if answer}
      <ul>
        {#each answer.voters ?? [] as voter (voter)}
          <li>
            <MemberIdentityRow userId={voter} {members} onProfile={onMemberProfile} />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</DialogFrame>

<style>
  .voters-dialog {
    display: grid;
    gap: var(--space-300);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  :global(.tab) {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-050) var(--space-200);
  }

  :global(.tab em) {
    font-style: normal;
  }

  ul {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    max-height: 16rem;
    overflow-y: auto;
    padding: 0;
  }
</style>
