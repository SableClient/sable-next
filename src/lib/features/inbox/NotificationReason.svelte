<script lang="ts">
  import ArrowBendUpLeftIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import AtIcon from 'phosphor-svelte/lib/AtIcon';
  import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import type { InboxItemView } from '#src/generated/protocol';
  import type { ClassValue } from 'svelte/elements';

  import { useEventItems } from '#lib/features/room/messages/event-items.svelte.js';
  import { i18n } from '#lib/i18n.js';

  let { item, class: className }: { item: InboxItemView; class?: ClassValue } = $props();
  const eventItems = useEventItems();

  let reply = $derived(
    item.reply || (eventItems.get(item.room_id, item.event_id)?.in_reply_to ?? null) !== null
  );
</script>

{#if reply || item.highlight || item.thread_root}
  <p class={['reason', className]}>
    {#if reply}
      <span
        ><ArrowBendUpLeftIcon aria-hidden="true" />{i18n.t(
          item.highlight ? 'inbox.repliedToYou' : 'inbox.reply'
        )}</span
      >
    {:else if item.highlight}
      <span><AtIcon aria-hidden="true" />{i18n.t('inbox.mention')}</span>
    {/if}
    {#if item.thread_root}
      <span><ChatCircleDotsIcon aria-hidden="true" />{i18n.t('inbox.inThread')}</span>
    {/if}
  </p>
{/if}

<style>
  .reason {
    color: var(--surface-var-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    margin: 0;
  }

  span {
    align-items: center;
    display: inline-flex;
    gap: var(--space-100);
  }
</style>
