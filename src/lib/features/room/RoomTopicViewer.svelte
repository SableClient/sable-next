<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  interface Props {
    open: boolean;
    roomName: string;
    topic: string;
    onOpenChange: (open: boolean) => void;
  }

  let { open, roomName, topic, onOpenChange }: Props = $props();
</script>

<DialogFrame {open} {onOpenChange} variant="verification" label={$i18n.t('room.topicTitle')}>
  <div class="topic-dialog">
    <h2>{roomName}</h2>
    <p class="topic-full">{topic}</p>
    <div class="topic-actions">
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}>{$i18n.t('room.topicClose')}</Button
      >
    </div>
  </div>
</DialogFrame>

<style>
  .topic-dialog {
    display: grid;
    gap: var(--space-3);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .topic-full {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    max-height: 60vh;
    overflow-wrap: anywhere;
    overflow-y: auto;
    white-space: pre-wrap;
  }

  .topic-actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
