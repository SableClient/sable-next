<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';

  import { memberName } from '../members/members.js';
  import { stateEventSubject, stateEventText, type Translate } from './state-event-text';
  import StateEventSubjectName from '../members/StateEventSubjectName.svelte';

  interface Props {
    item: TimelineItemView;
    members?: readonly MemberView[];
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
    reaction?: Snippet;
  }

  let { item, members = [], onSenderProfile, reaction }: Props = $props();
  const REACTION_MARKER = '\u0001';
  const translate: Translate = (key, values) =>
    reaction && key === 'timeline.hiddenReaction'
      ? $i18n.t(key, { ...values, key: REACTION_MARKER })
      : $i18n.t(key, values);
  let subject = $derived(onSenderProfile ? stateEventSubject(item, translate) : null);
  let subjectName = $derived(
    subject && subject.name === subject.userId ? memberName(members, subject.userId) : subject?.name
  );
</script>

{#snippet textWithReaction(text: string)}
  {#if reaction}
    {#each text.split(REACTION_MARKER) as part, index (index)}
      {#if index > 0}{@render reaction()}{/if}{part}
    {/each}
  {:else}{text}{/if}
{/snippet}

<span class="state-event-text"
  >{#if subject}{@render textWithReaction(subject.before)}<StateEventSubjectName
      userId={subject.userId}
      name={subjectName ?? subject.name}
      onProfile={onSenderProfile}
    />{@render textWithReaction(subject.after)}{:else}{@render textWithReaction(
      stateEventText(item, translate)
    )}{/if}</span
>

<style>
  .state-event-text {
    display: inline;
  }
</style>
