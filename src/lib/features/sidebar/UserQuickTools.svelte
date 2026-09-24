<script lang="ts">
  import { goto } from '$app/navigation';
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
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import AccountSwitcher from './AccountSwitcher.svelte';
  import '#lib/ui/primitives/nav-tab.css';
  import './sidebar-tools.css';

  interface Props {
    mobile?: boolean;
    compact?: boolean;
    onNavigate?: (href: string) => void;
  }

  let { mobile = false, compact = false, onNavigate }: Props = $props();
  const roomList = useRoomList();

  const notificationMode = (roomId: string) => roomList.notificationMode(roomId);
  let inboxCount = $derived(
    countNotifications(roomList.rooms, notificationMode) +
      countInvites(
        roomList.rooms.filter(
          (room) => !isDeclining(room.room_id) && !dismissedInvites.has(room.room_id)
        )
      )
  );
  let inboxCounts = $derived({
    unread: 0,
    highlight: inboxCount,
    marked: hasMarkedUnread(roomList.rooms, notificationMode),
  });

  const mobileTools = [
    { href: '/rooms', icon: ChatsIcon, label: 'nav.messages' },
    { href: null, icon: ListMagnifyingGlassIcon, label: 'shortcuts.openRoomSearch' },
    { href: '/inbox', icon: BellIcon, label: 'nav.inbox' },
  ] as const;
  const mobileSlotCount = mobileTools.length + 1;
  const desktopTools = [
    { href: '/inbox', icon: BellIcon, label: 'nav.inbox' },
    { href: '/settings', icon: GearIcon, label: 'nav.settings' },
  ] as const;
  const compactTools = [
    { href: '/search', icon: MagnifyingGlassIcon, label: 'search.title' },
    ...desktopTools,
  ] as const;

  function activateTool(event: MouseEvent, href: string): void {
    if (
      href === '/inbox' &&
      (page.url.pathname === href || page.state.inbox === true) &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      event.button === 0
    ) {
      event.preventDefault();
      history.back();
      return;
    }

    if (
      href === '/inbox' &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      event.button === 0
    ) {
      event.preventDefault();
      void goto('', { shallow: true, state: { ...page.state, inbox: true } });
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
    if (href === '/inbox') return page.state.inbox === true || page.url.pathname === href;
    return page.url.pathname.startsWith(href);
  }

  let mobileSelectedIndex = $derived(
    mobileTools.findIndex((item) => item.href !== null && isToolActive(item.href))
  );
</script>

{#snippet roomSwitcher(toolClass: string, side: 'top' | 'right')}
  {#snippet switcherTrigger({ props }: { props: Record<string, unknown> })}
    <button
      {...props}
      type="button"
      class="quick-tool {toolClass} nav-tab nav-tab-outlined selection-layer"
      aria-label={$i18n.t('shortcuts.openRoomSearch')}
      onclick={() => (paletteState.open = true)}
    >
      <span class="tool-icon" aria-hidden="true"><ListMagnifyingGlassIcon /></span>
    </button>
  {/snippet}
  <Tooltip label={$i18n.t('shortcuts.openRoomSearch')} {side} trigger={switcherTrigger} />
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
      {@const toolActive = item.href !== null && isToolActive(item.href)}
      <div class="mobile-tool-slot">
        {#if item.href === null}
          <button
            type="button"
            class="quick-tool mobile-tool"
            aria-label={$i18n.t(item.label)}
            onclick={() => (paletteState.open = true)}
          >
            <span class="mobile-icon" aria-hidden="true"><item.icon /></span>
          </button>
        {:else}
          {@const href = item.href}
          <a
            class="quick-tool mobile-tool"
            {href}
            onclick={(event) => {
              activateTool(event, href);
            }}
            aria-label={toolLabel(item)}
            aria-current={toolActive ? 'page' : undefined}
          >
            <span class="mobile-icon" aria-hidden="true"
              ><item.icon weight={toolActive ? 'fill' : 'regular'} /></span
            >
            {#if item.href === '/inbox'}
              <UnreadBadge counts={inboxCounts} aria-hidden="true" />
            {/if}
          </a>
        {/if}
      </div>
    {/each}
    <div class="mobile-tool-slot">
      <AccountSwitcher mode="mobile" />
    </div>
  </nav>
{:else if compact}
  <nav class="compact-tools" aria-label={$i18n.t('nav.quickTools')}>
    {@render roomSwitcher('compact-tool nav-tab-side', 'right')}
    {#each compactTools as item (item.href)}
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
          >
            <span class="tool-icon" aria-hidden="true"
              ><item.icon weight={toolActive ? 'fill' : 'regular'} /></span
            >
            {#if item.href === '/inbox'}
              <UnreadBadge counts={inboxCounts} aria-hidden="true" />
            {/if}
          </a>
        {/snippet}
        <Tooltip
          label={$i18n.t(item.label)}
          disabled={item.href === '/inbox' && page.state.inbox === true}
          {trigger}
        />
      {/each}
    </div>
  </nav>
{/if}

<style>
  .quick-tool {
    position: relative;
  }

  .mobile-tool :global(.unread-badge) {
    position: absolute;
    right: 0.125rem;
    top: 0.125rem;
  }

  .desktop-tools {
    align-items: center;
    background: var(--surface-container);
    border-right: var(--border-width) solid var(--surface-container-line);
    border-top: var(--border-width) solid var(--surface-container-line);
    box-sizing: border-box;
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
    container-type: inline-size;
    display: grid;
    grid-template-columns: repeat(var(--mobile-slot-count), minmax(0, 1fr));
    min-height: calc(4.25rem + var(--edge-inset-bottom));
    padding: var(--space-100) 0 calc(var(--space-100) + var(--edge-inset-bottom));
    position: relative;
    width: 100%;
  }

  .mobile-tools::before {
    background: var(--surface-container-active);
    border-radius: var(--radius-pill);
    box-shadow: inset 0 0 0 var(--border-width) var(--primary-main);
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
    width: var(--control-height-large);
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

  .mobile-icon,
  .tool-icon {
    display: flex;
  }

  .mobile-icon :global(svg) {
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  @media (prefers-reduced-motion: no-preference) {
    .mobile-tools::before {
      transition:
        translate var(--duration-fast) var(--ease-smooth-out),
        opacity var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
