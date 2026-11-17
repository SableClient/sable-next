<script lang="ts">
  import type { MemberView, RoomAttachmentKind } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { inlineKey } from '#lib/language.svelte.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  import RoomFileAttachments from './RoomFileAttachments.svelte';
  import RoomLinkAttachments from './RoomLinkAttachments.svelte';
  import RoomMediaAttachments from './RoomMediaAttachments.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onJump: (eventId: string) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onClose?: () => void;
  }

  let { roomId, members, modal = false, onJump, onMatrixLink, onClose }: Props = $props();

  const tabs: readonly { id: RoomAttachmentKind; label: string }[] = [
    { id: 'media', label: 'timeline.attachmentsMedia' },
    { id: 'file', label: 'timeline.attachmentsFiles' },
    { id: 'link', label: 'timeline.attachmentsLinks' },
  ];

  let kind = $state<RoomAttachmentKind>('media');

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

<div
  class="attachments-panel"
  role="tabpanel"
  id="attachments-panel"
  aria-labelledby={`attachments-tab-${kind}`}
>
  {#if kind === 'media'}
    <RoomMediaAttachments {roomId} {members} {modal} {onJump} {onClose} />
  {:else if kind === 'file'}
    <RoomFileAttachments {roomId} {members} {modal} {onJump} {onClose} />
  {:else}
    <RoomLinkAttachments {roomId} {members} {modal} {onJump} {onMatrixLink} {onClose} />
  {/if}
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--space-100);
    padding: var(--space-300) var(--space-300) 0;
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

  .attachments-panel {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
</style>
