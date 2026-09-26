<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import type { MatrixLink } from './matrix-link';
  import { topicHtml } from './topic-html';

  interface Props {
    open: boolean;
    roomName: string;
    topic: string;
    onOpenChange: (open: boolean) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { open, roomName, topic, onOpenChange, onMatrixLink }: Props = $props();
</script>

<DialogFrame {open} {onOpenChange} variant="verification" label={$i18n.t('room.topicTitle')}>
  <div class="topic-dialog">
    <h2>{roomName}</h2>
    <div class="topic-full">
      <FormattedBody html={topicHtml(topic)} {onMatrixLink} />
    </div>
    <DialogActions>
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}>{$i18n.t('room.topicClose')}</Button
      >
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .topic-dialog {
    display: grid;
    gap: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .topic-full {
    color: var(--surface-var-on-container);
    margin: 0;
    max-height: 60vh;
    overflow-wrap: anywhere;
    overflow-y: auto;
  }
</style>
