<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import {
    defaultSettingsSection,
    openSettingsOver,
  } from '#lib/features/settings/settings-navigation.js';
  import { countInvites, countNotifications, hasMarkedUnread } from '#lib/features/inbox/inbox.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
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

  let inboxCount = $derived(countNotifications(roomList.rooms) + countInvites(roomList.rooms));
  let inboxCounts = $derived({
    unread: 0,
    highlight: inboxCount,
    marked: hasMarkedUnread(roomList.rooms),
  });

  const mobileTools = [
    { href: '/rooms', icon: ChatsIcon, label: 'nav.messages' },
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
  function toolLabel(item: { href: string; label: string }): string {
    if (item.href !== '/inbox' || inboxCount === 0) return $i18n.t(item.label);
    return $i18n.t('inbox.navLabel', { count: inboxCount });
  }

  function isToolActive(href: string): boolean {
    if (href === '/inbox') return page.state.inbox === true || page.url.pathname === href;
    return page.url.pathname.startsWith(href);
  }

  let mobileSelectedIndex = $derived(mobileTools.findIndex((item) => isToolActive(item.href)));
  let mobileSelectedPosition = $derived(
    mobileSelectedIndex < 0
      ? '50%'
      : `${String(((mobileSelectedIndex + 0.5) / mobileSlotCount) * 100)}%`
  );
</script>

{#if mobile}
  <nav
    class="mobile-tools"
    class:selection-active={mobileSelectedIndex >= 0}
    style:--mobile-selected-position={mobileSelectedPosition}
    aria-label={$i18n.t('nav.quickTools')}
  >
    {#each mobileTools as item (item.href)}
      {@const toolActive = isToolActive(item.href)}
      <div class="mobile-tool-slot">
        <a
          class="quick-tool mobile-tool"
          href={item.href}
          onclick={(event) => {
            activateTool(event, item.href);
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
      </div>
    {/each}
    <div class="mobile-tool-slot">
      <AccountSwitcher mode="mobile" />
    </div>
  </nav>
{:else if compact}
  <nav class="compact-tools" aria-label={$i18n.t('nav.quickTools')}>
    {#each compactTools as item (item.href)}
      {@const toolActive = isToolActive(item.href)}
      {#snippet trigger({ props }: { props: Record<string, unknown> })}
        <a
          {...props}
          class="quick-tool compact-tool sable-nav-tab sable-nav-tab-side sable-nav-tab-outlined
          sable-current sable-selection-layer"
          href={item.href}
          onclick={(event) => {
            activateTool(event, item.href);
          }}
          aria-label={toolLabel(item)}
          aria-current={toolActive ? 'page' : undefined}
        >
          <span aria-hidden="true"><item.icon weight={toolActive ? 'fill' : 'regular'} /></span>
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
      {#each desktopTools as item (item.href)}
        {@const toolActive = isToolActive(item.href)}
        {#snippet trigger({ props }: { props: Record<string, unknown> })}
          <a
            {...props}
            class="quick-tool desktop-tool sable-nav-tab sable-nav-tab-bottom
            sable-nav-tab-outlined sable-current sable-selection-layer"
            href={item.href}
            onclick={(event) => {
              activateTool(event, item.href);
            }}
            aria-label={toolLabel(item)}
            aria-current={toolActive ? 'page' : undefined}
          >
            <span aria-hidden="true"><item.icon weight={toolActive ? 'fill' : 'regular'} /></span>
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

  .mobile-tool :global(.sable-unread-badge) {
    position: absolute;
    right: 0.125rem;
    top: 0.125rem;
  }

  .desktop-tools {
    align-items: center;
    background: var(--sable-surface-container);
    border-right: var(--border-width) solid var(--sable-surface-container-line);
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    box-sizing: border-box;
    display: flex;
    flex: 0 0 4.625rem;
    justify-content: space-between;
    min-height: 4.625rem;
    padding: 0 var(--space-300);
  }

  .desktop-tool-actions {
    display: flex;
    gap: var(--space-300);
  }

  .compact-tools {
    align-items: center;
    background: var(--sable-bg-container);
    border-right: var(--border-width) solid var(--sable-bg-container-line);
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
    background: var(--sable-surface-container);
    border-radius: var(--radius) var(--radius) 0 0;
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    box-sizing: border-box;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    min-height: 4.25rem;
    padding: var(--space-100);
    position: relative;
    width: 100%;
  }

  .mobile-tools::before {
    background: var(--sable-surface-container-active);
    border-radius: var(--radius-pill);
    box-shadow: inset 0 0 0 var(--border-width) var(--sable-primary-main);
    content: '';
    height: var(--control-height-large);
    left: var(--mobile-selected-position);
    opacity: 0;
    pointer-events: none;
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
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

  .mobile-icon {
    display: flex;
  }

  .mobile-icon :global(svg) {
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  @media (prefers-reduced-motion: no-preference) {
    .mobile-tools::before {
      transition:
        left var(--motion-normal) var(--motion-easing-emphasized),
        opacity var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
