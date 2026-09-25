<script lang="ts">
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';

  import { memberName } from './members.js';
  import { stateEventSubject, stateEventText } from './state-event-text';
  import StateEventSubjectName from './StateEventSubjectName.svelte';

  interface Props {
    item: TimelineItemView;
    members?: readonly MemberView[];
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { item, members = [], onSenderProfile }: Props = $props();
  let subject = $derived(onSenderProfile ? stateEventSubject(item, $i18n.t) : null);
  let subjectName = $derived(
    subject && subject.name === subject.userId ? memberName(members, subject.userId) : subject?.name
  );
</script>

{#if subject}{subject.before}<StateEventSubjectName
    userId={subject.userId}
    name={subjectName ?? subject.name}
    onProfile={onSenderProfile}
  />{subject.after}{:else}{stateEventText(item, $i18n.t)}{/if}
