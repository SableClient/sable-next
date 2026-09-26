<script lang="ts">
  import { diffWordsWithSpace } from 'diff';

  import type { TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { isRecord } from '#lib/guards.js';

  import { readEventSource } from './event-source-cache';
  import { editedBody, relationOf, type TimelineEventIndex } from './timeline-event-index';

  interface Props {
    item: TimelineItemView;
    roomId?: string;
    events?: TimelineEventIndex;
  }

  let { item, roomId = '', events }: Props = $props();
  const core = useCoreClient();

  let raw = $derived(item.content.kind === 'hidden_event' ? item.content.content : null);
  let after = $derived(editedBody(raw));
  let previous = $derived(events?.editBefore(item) ?? null);
  let original = $state<string | null>(null);
  let before = $derived(
    previous?.content.kind === 'hidden_event' ? editedBody(previous.content.content) : original
  );
  let segments = $derived(
    before !== null && after !== null && before !== after ? diffWordsWithSpace(before, after) : null
  );

  $effect(() => {
    const target = relationOf(raw)?.eventId;
    if (previous !== null || !target || !roomId) return;
    let current = true;
    original = null;
    const read = (room: string, id: string) => core.commands.eventSource(room, id);
    void readEventSource(read, roomId, target).then((event) => {
      const content = event?.content;
      if (current && isRecord(content) && typeof content.body === 'string') original = content.body;
    });
    return () => {
      current = false;
    };
  });
</script>

{#if segments}
  <span class="edit-diff"
    >{#each segments as segment, index (index)}{#if segment.added}<ins>{segment.value}</ins
        >{:else if segment.removed}<del>{segment.value}</del>{:else}<span>{segment.value}</span
        >{/if}{/each}</span
  >
{:else if after !== null}
  <span>{after}</span>
{/if}

<style>
  .edit-diff {
    white-space: pre-wrap;
  }

  ins {
    background: var(--success-container);
    color: var(--success-on-container);
    text-decoration: none;
  }

  del {
    background: var(--crit-container);
    color: var(--crit-on-container);
  }
</style>
