<script lang="ts">
  import type { MemberView, PollAnswerView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';

  import TabbedMemberListDialog from './TabbedMemberListDialog.svelte';

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
</script>

<TabbedMemberListDialog
  bind:open
  bind:active
  title={$i18n.t('timeline.pollVoters')}
  tabs={answers}
  tabKey={(answer) => answer.id}
  userIds={(answer) => answer.voters ?? []}
  {members}
  {onMemberProfile}
>
  {#snippet tab(answer)}
    <em>{answer.text}</em>
  {/snippet}
</TabbedMemberListDialog>
