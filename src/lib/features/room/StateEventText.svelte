<script lang="ts">
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { i18n } from '#lib/i18n.js';

  import { stateEventSubject, stateEventText } from './state-event-text';

  interface Props {
    item: TimelineItemView;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { item, onSenderProfile }: Props = $props();
  let subject = $derived(onSenderProfile ? stateEventSubject(item, $i18n.t) : null);

  function openProfile(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (subject) onSenderProfile?.(subject.userId, event.currentTarget);
  }
</script>

{#if subject}{subject.before}<button
    class="state-subject"
    type="button"
    aria-label={$i18n.t('timeline.senderProfile', { name: subject.name })}
    onclick={openProfile}>{subject.name}</button
  >{subject.after}{:else}{stateEventText(item, $i18n.t)}{/if}

<style>
  .state-subject {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: var(--font-weight-medium);
    padding: 0;
  }

  .state-subject:hover,
  .state-subject:focus-visible {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
