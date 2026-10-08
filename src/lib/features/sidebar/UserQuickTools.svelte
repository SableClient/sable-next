<script lang="ts">
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import {
    defaultSettingsSection,
    openSettingsOver,
  } from '#lib/features/settings/settings-navigation.js';
  import { countInvites, countNotifications, hasMarkedUnread } from '#lib/features/inbox/inbox.js';
  import { isDeclining } from '#lib/rooms/invites.svelte.js';
  import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { paletteState } from '#lib/ui/shortcuts/palette-state.svelte.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import ListMagnifyingGlassIcon from 'phosphor-svelte/lib/ListMagnifyingGlassIcon';
  import AccountSwitcher from './AccountSwitcher.svelte';
  import '#lib/ui/primitives/nav-tab.css';
  import './sidebar-tools.css';
  import AlertPopover from './AlertPopover.svelte';

  interface Props {
    mobile?: boolean;
    compact?: boolean;
    onNavigate?: (href: string) => void;
  }

  let { mobile = false, compact = false, onNavigate }: Props = $props();
  const roomList = useRoomList();

  let inboxCount = $derived(
    countNotifications(roomList.rooms, roomList.badgeUnreadFor) +
      countInvites(
        roomList.rooms.filter(
          (room) => !isDeclining(room.room_id) && !dismissedInvites.has(room.room_id)
        )
      )
  );
  let inboxCounts = $derived({
    unread: 0,
    highlight: inboxCount,
    marked: hasMarkedUnread(roomList.rooms, roomList.badgeUnreadFor),
  });

  let hasAlerts = $state(false);

  const mobileTools = [
    { href: '/rooms', icon: ChatsIcon, label: 'nav.messages' },
    { href: '/navigate', icon: ListMagnifyingGlassIcon, label: 'shortcuts.paletteTitle' },
    { href: '/inbox', icon: BellIcon, label: 'nav.inbox' },
  ] as const;
  const mobileSlotCount = $derived(mobileTools.length + 1 + (hasAlerts ? 1 : 0));
  const ROOM_LIST_PATHS = ['/rooms', '/direct', '/space/'];
  const desktopTools = [
    { href: '/inbox', icon: BellIcon, label: 'nav.inbox' },
    { href: '/settings', icon: GearIcon, label: 'nav.settings' },
  ] as const;

  function activateTool(event: MouseEvent, href: string): void {
    if (mobile) {
      onNavigate?.(href);
      return;
    }

    if (href === '/settings' && !mobile) {
      openSettingsOver(event, defaultSettingsSection());
      if (event.defaultPrevented) return;
    }

    onNavigate?.(href);
  }

  /** The badge is decorative, so the count has to reach the accessible name. */
  function toolLabel(item: { href: string | null; label: string }): string {
    if (item.href !== '/inbox' || inboxCount === 0) return $i18n.t(item.label);
    return $i18n.t('inbox.navLabel', { count: inboxCount });
  }

  function isToolActive(href: string): boolean {
    if (href === '/rooms')
      return ROOM_LIST_PATHS.some((path) => page.url.pathname.startsWith(path));
    return page.url.pathname.startsWith(href);
  }

  let mobileSelectedIndex = $derived.by(() => {
    if (page.url.pathname === '/profile') {
      return mobileTools.length;
    }

    if (page.url.pathname === '/alerts') {
      return mobileTools.length + 1;
    }

    return mobileTools.findIndex((item) => isToolActive(item.href));
  });
</script>

{#snippet roomSwitcher(toolClass: string, side: 'top' | 'right')}
  {#snippet switcherTrigger({ props }: { props: Record<string, unknown> })}
    <button
      {...props}
      type="button"
      class="quick-tool {toolClass} nav-tab nav-tab-outlined selection-layer"
      aria-label={$i18n.t('shortcuts.paletteTitle')}
      onclick={() => (paletteState.open = true)}
    >
      <span class="tool-icon" aria-hidden="true"><ListMagnifyingGlassIcon /></span>
    </button>
  {/snippet}
  <Tooltip label={$i18n.t('shortcuts.paletteTitle')} {side} trigger={switcherTrigger} />
{/snippet}

{#if mobile}
  <nav
    class="mobile-tools"
    class:selection-active={mobileSelectedIndex >= 0}
    style:--mobile-selected-index={String(Math.max(mobileSelectedIndex, 0))}
    style:--mobile-slot-count={String(mobileSlotCount)}
    aria-label={$i18n.t('nav.quickTools')}
  >
    {#each mobileTools as item (item.label)}
      {@const toolActive = isToolActive(item.href)}
      {@const href = item.href}
      <div class="mobile-tool-slot">
        <a
          class="quick-tool mobile-tool"
          {href}
          onclick={(event) => {
            activateTool(event, href);
          }}
          aria-label={toolLabel(item)}
          aria-current={toolActive ? 'page' : undefined}
          draggable="false"
        >
          <span class="mobile-icon" aria-hidden="true"
            ><item.icon weight={toolActive ? 'fill' : 'regular'} /></span
          >
          {#if item.href === '/inbox'}
            <UnreadBadge counts={inboxCounts} aria-hidden="true" />
          {/if}
        </a>
      </div>
    {/each}
    <div class="mobile-tool-slot">
      <AccountSwitcher mode="mobile" />
    </div>
    <div class="mobile-tool-slot">
      <AlertPopover mode="mobile" bind:hasAlerts />
    </div>
  </nav>
{:else if compact}
  <nav class="compact-tools" aria-label={$i18n.t('nav.quickTools')}>
    <AlertPopover mode="compact" />
    {@render roomSwitcher('compact-tool nav-tab-side', 'right')}
    {#each desktopTools as item (item.href)}
      {@const toolActive = isToolActive(item.href)}
      {#snippet trigger({ props }: { props: Record<string, unknown> })}
        <a
          {...props}
          class="quick-tool compact-tool nav-tab nav-tab-side nav-tab-outlined
          selection-current selection-layer"
          href={item.href}
          onclick={(event) => {
            activateTool(event, item.href);
          }}
          aria-label={toolLabel(item)}
          aria-current={toolActive ? 'page' : undefined}
          draggable="false"
        >
          <span class="tool-icon" aria-hidden="true"
            ><item.icon weight={toolActive ? 'fill' : 'regular'} /></span
          >
          {#if item.href === '/inbox'}
            <UnreadBadge counts={inboxCounts} aria-hidden="true" />
          {/if}
        </a>
      {/snippet}
      <Tooltip label={$i18n.t(item.label)} side="right" {trigger} />
    {/each}
    <AccountSwitcher mode="compact" />
  </nav>
{:else}
  <nav class="desktop-tools" aria-label={$i18n.t('nav.quickTools')}>
    <AccountSwitcher mode="desktop" />
    <div class="desktop-tool-actions">
      <AlertPopover mode="desktop" />
      {@render roomSwitcher('desktop-tool nav-tab-bottom', 'top')}
      {#each desktopTools as item (item.href)}
        {@const toolActive = isToolActive(item.href)}
        {#snippet trigger({ props }: { props: Record<string, unknown> })}
          <a
            {...props}
            class="quick-tool desktop-tool nav-tab nav-tab-bottom
            nav-tab-outlined selection-current selection-layer"
            href={item.href}
            onclick={(event) => {
              activateTool(event, item.href);
            }}
            aria-label={toolLabel(item)}
            aria-current={toolActive ? 'page' : undefined}
            draggable="false"
          >
            <span class="tool-icon" aria-hidden="true"
              ><item.icon weight={toolActive ? 'fill' : 'regular'} /></span
            >
            {#if item.href === '/inbox'}
              <UnreadBadge counts={inboxCounts} aria-hidden="true" />
            {/if}
          </a>
        {/snippet}
        <Tooltip label={$i18n.t(item.label)} {trigger} />
      {/each}
    </div>
  </nav>
{/if}

<style>
  .quick-tool {
    position: relative;
  }

  .desktop-tools {
    align-items: center;
    background: var(--surface-container);
    border-right: var(--border-width) solid var(--surface-container-line);
    border-top: var(--border-width) solid var(--surface-container-line);
    box-sizing: border-box;
    color: var(--surface-on-container);
    display: flex;
    flex: 0 0 var(--sidebar-footer-height);
    justify-content: space-between;
    min-height: var(--sidebar-footer-height);
    padding: 0 var(--space-300);
  }

  .desktop-tool-actions {
    display: flex;
    gap: var(--space-300);
  }

  .compact-tools {
    align-items: center;
    background: var(--bg-container);
    border-right: var(--border-width) solid var(--bg-container-line);
    box-sizing: border-box;
    color: var(--bg-on-container);
    display: flex;
    flex: 0 0 var(--navigation-rail-width);
    flex-direction: column;
    gap: var(--space-200);
    padding: var(--space-200) 0 var(--space-300);
    width: var(--navigation-rail-width);
  }

  .mobile-tools {
    align-items: center;
    background: var(--surface-container);
    border-radius: var(--radius) var(--radius) 0 0;
    border-top: var(--border-width) solid var(--surface-container-line);
    box-sizing: border-box;
    color: var(--surface-on-container);
    container-type: inline-size;
    display: grid;
    grid-template-columns: repeat(var(--mobile-slot-count), minmax(0, 1fr));
    min-height: calc(4.25rem + var(--edge-inset-bottom));
    padding: var(--space-100) 0 calc(var(--space-100) + var(--edge-inset-bottom));
    position: relative;
    width: 100%;
  }

  .mobile-tools::before {
    background: var(--primary-container);
    border-radius: var(--radius-pill);
    content: '';
    height: var(--control-height-large);
    left: 0;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    top: calc(50% - var(--edge-inset-bottom) / 2);
    translate: calc(
        (var(--mobile-selected-index) + 0.5) * 100cqi / var(--mobile-slot-count) - 50%
      ) -50%;
    width: min(
      calc(var(--control-height-large) + var(--space-400)),
      calc(100cqi / var(--mobile-slot-count) - var(--space-200))
    );
    z-index: 0;
  }

  .mobile-tools.selection-active::before {
    opacity: 1;
  }

  .mobile-tool-slot {
    align-items: center;
    display: flex;
    justify-content: center;
    min-width: 0;
    position: relative;
    z-index: 1;
  }

  @media (prefers-reduced-motion: no-preference) {
    .mobile-tools::before {
      transition:
        translate var(--duration-fast) var(--ease-smooth-out),
        opacity var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
