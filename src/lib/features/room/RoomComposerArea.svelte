<script lang="ts">
  import type { MemberView, RoomListItemView } from '#src/generated/protocol';

  import ScheduledMessages from '#lib/features/composer/ScheduledMessages.svelte';

  import ConversationComposer from './conversation/ConversationComposer.svelte';
  import type { Conversation } from './conversation/conversation.svelte.js';
  import type { RoomRules } from './room-rules.svelte.js';
  import type { RoomSession } from './room-session.svelte.js';
  import type { TombstoneJoin } from './room-tombstone-join.svelte.js';
  import RoomPresencePrompt from './RoomPresencePrompt.svelte';
  import RoomRulesBanner from './RoomRulesBanner.svelte';
  import RoomTombstoneBanner from './RoomTombstoneBanner.svelte';
  import type { ReplyDirection } from './timeline/timeline-format';

  interface Props {
    conversation: Conversation;
    roomId: string;
    roomName: string;
    room: RoomListItemView | undefined;
    members: readonly MemberView[];
    roomSession: RoomSession;
    tombstoneJoin: TombstoneJoin;
    rules: RoomRules;
    tombstoned: boolean;
    mounted: boolean;
    canPost: boolean;
    canReact: boolean;
    composer?: ConversationComposer;
    onReplyStep: (direction: ReplyDirection) => void;
    onJumpToContext: (eventId: string) => void;
  }

  let {
    conversation,
    roomId,
    roomName,
    room,
    members,
    roomSession,
    tombstoneJoin,
    rules,
    tombstoned,
    mounted,
    canPost,
    canReact,
    composer = $bindable(),
    onReplyStep,
    onJumpToContext,
  }: Props = $props();
</script>

{#if tombstoned}
  <RoomTombstoneBanner
    isSpace={room?.room_kind === 'space'}
    body={roomSession.tombstoneBody}
    resolved={roomSession.tombstoneChecked}
    successorId={roomSession.tombstoneReplacementId}
    joined={tombstoneJoin.successorJoined}
    joining={tombstoneJoin.joining}
    failed={tombstoneJoin.failed}
    onOpen={() => tombstoneJoin.open()}
    onJoin={() => void tombstoneJoin.join()}
  />
{:else if rules.blocking}
  <RoomRulesBanner onView={() => (rules.open = true)} />
{:else}
  <RoomPresencePrompt {roomId} roomName={room?.display_name ?? ''} />
  {#if mounted}
    <ScheduledMessages
      {roomId}
      revision={conversation.scheduledRevision}
      editing={conversation.context?.kind === 'schedule' ? conversation.context.eventId : null}
      onEdit={conversation.editScheduled}
    />
    <ConversationComposer
      bind:this={composer}
      {conversation}
      {roomId}
      roomMembers={members}
      onSchedule={conversation.schedule}
      {canReact}
      {roomName}
      readOnly={!canPost}
      encrypted={room?.encrypted ?? null}
      onDeleteEdited={conversation.redact}
      onEditLast={conversation.editLast}
      onEditNext={conversation.editNext}
      {onReplyStep}
      {onJumpToContext}
    />
  {/if}
{/if}
