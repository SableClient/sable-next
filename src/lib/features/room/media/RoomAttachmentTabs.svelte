<script lang="ts">
  import type { RoomAttachmentKind } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { inlineKey } from '#lib/language.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    kind: RoomAttachmentKind;
  }

  let { kind = $bindable() }: Props = $props();

  const tabs: readonly { id: RoomAttachmentKind; label: string }[] = [
    { id: 'media', label: 'timeline.attachmentsMedia' },
    { id: 'file', label: 'timeline.attachmentsFiles' },
    { id: 'link', label: 'timeline.attachmentsLinks' },
  ];

  function selectTab(next: RoomAttachmentKind, focus: boolean): void {
    kind = next;
    if (focus) document.getElementById(`attachments-tab-${next}`)?.focus();
  }

  function tabKeydown(event: KeyboardEvent): void {
    const index = tabs.findIndex((tab) => tab.id === kind);
    const last = tabs.length - 1;
    const next =
      inlineKey(event.key) === 'ArrowRight'
        ? (index + 1) % tabs.length
        : inlineKey(event.key) === 'ArrowLeft'
          ? (index + last) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) selectTab(tab.id, true);
  }
</script>

<div class="tabs" role="tablist" aria-label={i18n.t('timeline.attachmentsTitle')}>
  {#each tabs as tab (tab.id)}
    <Button
      size="small"
      variant="ghost"
      class="attachments-tab choice"
      role="tab"
      id={`attachments-tab-${tab.id}`}
      aria-controls="attachments-panel"
      aria-selected={kind === tab.id}
      tabindex={kind === tab.id ? 0 : -1}
      onkeydown={tabKeydown}
      onclick={() => {
        selectTab(tab.id, false);
      }}
    >
      {i18n.t(tab.label)}
    </Button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--space-100);
  }

  .tabs :global(.attachments-tab) {
    position: relative;
  }

  .tabs :global(.attachments-tab)::after {
    content: '';
    inset-block: calc((var(--button-height) - var(--target-hit)) / 2);
    inset-inline: 0;
    position: absolute;
  }
</style>
