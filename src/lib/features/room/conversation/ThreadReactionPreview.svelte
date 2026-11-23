<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import type { MemberView, ReactionGroup } from '#src/generated/protocol';
  import MessageReactions from '../messages/MessageReactions.svelte';

  let {
    roomId,
    eventId,
    known = [],
    members = [],
    currentUserId = null,
  }: {
    roomId: string;
    eventId: string;
    known?: readonly ReactionGroup[];
    members?: readonly MemberView[];
    currentUserId?: string | null;
  } = $props();

  const core = useCoreClient();
  let fetched = $state.raw<ReactionGroup[] | null>(null);
  let visible = $state(false);
  let reactions = $derived(known.length > 0 ? known : (fetched ?? []));

  $effect(() => {
    fetched = null;
    if (!visible || known.length > 0) return;
    let current = true;
    void core.rpc.messages.eventReactions({ room_id: roomId, event_id: eventId }).then(
      (result) => {
        if (current) fetched = result;
      },
      (error: unknown) => {
        console.debug('[sable threads] reaction preview unavailable', error);
      }
    );
    return () => {
      current = false;
    };
  });
</script>

<div class="thread-reactions" {@attach whenVisible(() => (visible = true))}>
  {#if reactions.length > 0}
    <MessageReactions
      reactions={[...reactions]}
      {eventId}
      {currentUserId}
      {members}
      {roomId}
      actionable={false}
    />
  {/if}
</div>
