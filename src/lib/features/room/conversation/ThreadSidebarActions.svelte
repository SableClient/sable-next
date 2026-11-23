<script lang="ts">
  import type { Snippet } from 'svelte';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import type { TimelineItemView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import {
    saveThreadSidebarAction,
    useThreadSidebar,
  } from '#lib/features/sidebar/thread-sidebar.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';

  let {
    roomId,
    rootId,
    root = null,
    compact = false,
  }: {
    roomId: string;
    rootId: string;
    root?: TimelineItemView | null;
    compact?: boolean;
  } = $props();

  const sidebar = useThreadSidebar();
  let pinned = $derived(sidebar?.hasPin(roomId, rootId) ?? false);
  let dismissed = $derived(sidebar?.isDismissed(roomId, rootId) ?? false);
  let showDismiss = $derived(
    sidebar !== undefined && (dismissed || sidebar.isAutoListed(roomId, rootId))
  );
</script>

{#snippet actionButton(
  label: string,
  pressed: boolean,
  disabled: boolean,
  onclick: () => void,
  icon: Snippet
)}
  {#if compact}
    <IconButton
      class="thread-sidebar-action"
      variant="ghost"
      size="small"
      {label}
      aria-pressed={pressed}
      {disabled}
      {onclick}
    >
      {@render icon()}
    </IconButton>
  {:else}
    <PanelHeaderButton {label} aria-pressed={pressed} {disabled} {onclick}>
      {@render icon()}
    </PanelHeaderButton>
  {/if}
{/snippet}

{#if sidebar}
  {#if showDismiss}
    {#snippet dismissIcon()}
      <EyeSlashIcon weight={dismissed ? 'fill' : 'regular'} />
    {/snippet}
    {@render actionButton(
      i18n.t(dismissed ? 'timeline.threadRestoreSidebar' : 'timeline.threadDismissSidebar'),
      dismissed,
      !sidebar.ready,
      () => {
        saveThreadSidebarAction(
          sidebar.setDismissed(roomId, rootId, !dismissed),
          'timeline.threadDismissFailed',
          'sidebar dismissal'
        );
      },
      dismissIcon
    )}
  {/if}
  {#snippet pinIcon()}
    <PushPinIcon weight={pinned ? 'fill' : 'regular'} />
  {/snippet}
  {@render actionButton(
    i18n.t(pinned ? 'timeline.threadUnpin' : 'timeline.threadPin'),
    pinned,
    !sidebar.ready || (!root && !pinned),
    () => {
      saveThreadSidebarAction(
        sidebar.togglePin(roomId, rootId, root),
        'timeline.threadPinFailed',
        'personal pin'
      );
    },
    pinIcon
  )}
{/if}

<style>
  :global(.thread-sidebar-action) {
    flex: none;
    margin-inline-start: var(--space-050);
  }
</style>
