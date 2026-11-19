<script lang="ts">
  import type { Component } from 'svelte';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import BellRingingIcon from 'phosphor-svelte/lib/BellRingingIcon';
  import BellSlashIcon from 'phosphor-svelte/lib/BellSlashIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import type { NotificationModeView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import type { UnreadCount } from '#lib/rooms/unread.js';
  import TypingDots from '#lib/ui/primitives/TypingDots.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';

  import { unreadLabel } from './unread-label.js';

  interface Props {
    counts: UnreadCount;
    dm: boolean;
    typing: boolean;
    collapsed: boolean;
    notifyMode: NotificationModeView | null;
    dotHidden: boolean;
  }

  let { counts, dm, typing, collapsed, notifyMode, dotHidden }: Props = $props();

  let badgeLabel = $derived(unreadLabel(counts) ?? i18n.t('nav.markedUnread'));

  function notificationChip(mode: NotificationModeView): { icon: Component; label: string } {
    if (mode === 'mute') return { icon: BellSlashIcon, label: 'room.notifyMute' };
    if (mode === 'mentions') return { icon: BellIcon, label: 'room.notifyMentions' };

    return { icon: BellRingingIcon, label: 'room.notifyAll' };
  }
</script>

{#if !collapsed}
  <span class="room-status">
    {#if typing}
      <span class="room-typing"><TypingDots /></span>
    {:else}
      <UnreadBadge {counts} {dm} role="img" aria-label={badgeLabel} />
    {/if}
    {#if notifyMode}
      {@const chip = notificationChip(notifyMode)}
      <span class="room-mode" role="img" aria-label={i18n.t(chip.label)}>
        <chip.icon />
      </span>
    {/if}
    {#if dotHidden}
      <span class="room-mode" role="img" aria-label={i18n.t('room.unreadDotHidden')}>
        <EyeSlashIcon />
      </span>
    {/if}
  </span>
{:else if !typing}
  <UnreadBadge class="room-collapsed-badge" {counts} {dm} role="img" aria-label={badgeLabel} />
{/if}

<style>
  .room-status {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-100);
    justify-content: center;
  }

  .room-status:has(> *) {
    min-width: 1.5rem;
  }

  .room-status :global(.unread-badge-dot) {
    background-clip: content-box;
    padding-inline: var(--space-200);
    width: var(--space-600);
  }

  .room-typing,
  .room-mode {
    align-items: center;
    display: flex;
    flex: none;
  }

  .room-typing {
    background: var(--sec-container);
    border: var(--border-width) solid var(--sec-container-line);
    border-radius: var(--radius-pill);
    height: 1.25rem;
    padding: 0 var(--space-150);
  }

  .room-mode {
    justify-content: center;
    opacity: var(--opacity-p300);
    width: var(--space-600);
  }

  .room-mode :global(svg) {
    height: var(--size-x200);
    width: var(--size-x200);
  }
</style>
