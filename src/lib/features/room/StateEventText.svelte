<script lang="ts">
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { i18n } from '#lib/i18n.js';

  import { stateEventSubject, stateEventText } from './state-event-text';
  import StateEventSubjectName from './StateEventSubjectName.svelte';

  interface Props {
    item: TimelineItemView;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { item, onSenderProfile }: Props = $props();
  let subject = $derived(onSenderProfile ? stateEventSubject(item, $i18n.t) : null);
</script>

{#if subject}{subject.before}<StateEventSubjectName
    userId={subject.userId}
    name={subject.name}
    onProfile={onSenderProfile}
  />{subject.after}{:else}{stateEventText(item, $i18n.t)}{/if}
