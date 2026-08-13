<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import {
    openSettingsOverlay,
    settingsOverlay,
  } from '$lib/features/settings/settings-overlay.svelte';
  import Tooltip from '$lib/ui/primitives/Tooltip.svelte';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import AccountSwitcher from './AccountSwitcher.svelte';
  import './sidebar-tools.css';

  interface Props {
    mobile?: boolean;
    compact?: boolean;
    onNavigate?: (href: string) => void;
  }

  let { mobile = false, compact = false, onNavigate }: Props = $props();

  const mobileTools = [
    { href: '/home', icon: ChatsIcon, label: 'nav.messages' },
    { href: '/inbox', icon: BellIcon, label: 'nav.inbox' },
  ] as const;
  const desktopTools = [
    { href: '/inbox', icon: BellIcon, label: 'nav.inbox' },
    { href: '/settings', icon: GearIcon, label: 'nav.settings' },
  ] as const;
  const compactTools = [
    { href: '/navigate', icon: MagnifyingGlassIcon, label: 'nav.navigate' },
    ...desktopTools,
  ] as const;

  function activateTool(event: MouseEvent, href: string): void {
    if (href === '/settings' && !mobile) {
      event.preventDefault();
      openSettingsOverlay();
      return;
    }

    onNavigate?.(href);
  }

  function isToolActive(href: string): boolean {
    return page.url.pathname.startsWith(href) || (href === '/settings' && settingsOverlay.open);
  }
</script>

{#if mobile}
  <nav class="mobile-tools" aria-label={$i18n.t('nav.quickTools')}>
    {#each mobileTools as item (item.href)}
      {@const toolActive = isToolActive(item.href)}
      <a
        class="quick-tool mobile-tool"
        class:active={toolActive}
        href={resolve(item.href)}
        onclick={(event) => {
          activateTool(event, item.href);
        }}
        aria-current={toolActive ? 'page' : undefined}
      >
        <span class="mobile-icon" aria-hidden="true"><item.icon /></span>
        <span>{$i18n.t(item.label)}</span>
      </a>
    {/each}
    <AccountSwitcher mode="mobile" />
  </nav>
{:else if compact}
  <nav class="compact-tools" aria-label={$i18n.t('nav.quickTools')}>
    {#each compactTools as item (item.href)}
      {@const toolActive = isToolActive(item.href)}
      {#snippet trigger({ props }: { props: Record<string, unknown> })}
        <a
          {...props}
          class="quick-tool compact-tool"
          class:active={toolActive}
          href={resolve(item.href)}
          onclick={(event) => {
            activateTool(event, item.href);
          }}
          aria-label={$i18n.t(item.label)}
          aria-current={toolActive ? 'page' : undefined}
        >
          <span aria-hidden="true"><item.icon /></span>
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
            class="quick-tool desktop-tool"
            class:active={toolActive}
            href={resolve(item.href)}
            onclick={(event) => {
              activateTool(event, item.href);
            }}
            aria-label={$i18n.t(item.label)}
            aria-current={toolActive ? 'page' : undefined}
          >
            <span aria-hidden="true"><item.icon /></span>
          </a>
        {/snippet}
        <Tooltip label={$i18n.t(item.label)} {trigger} />
      {/each}
    </div>
  </nav>
{/if}

<style>
  .desktop-tools {
    align-items: center;
    background: var(--sable-surface-container);
    border-top: 1px solid var(--sable-surface-container-line);
    box-sizing: border-box;
    display: flex;
    flex: 0 0 4.625rem;
    justify-content: space-between;
    min-height: 4.625rem;
    padding: 0 0.75rem;
  }

  .desktop-tool-actions {
    display: flex;
    gap: 0.5rem;
  }

  .compact-tools {
    align-items: center;
    background: var(--sable-bg-container);
    border-right: 1px solid var(--sable-bg-container-line);
    box-sizing: border-box;
    display: flex;
    flex: 0 0 var(--navigation-rail-width);
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0 0.75rem;
    width: var(--navigation-rail-width);
  }

  .mobile-tools {
    background: var(--sable-surface-container);
    border-radius: var(--radius) var(--radius) 0 0;
    border-top: 1px solid var(--sable-surface-container-line);
    box-sizing: border-box;
    display: flex;
    justify-content: space-around;
    min-height: calc(4.25rem + env(safe-area-inset-bottom));
    padding: 0.25rem env(safe-area-inset-right) calc(0.25rem + env(safe-area-inset-bottom))
      env(safe-area-inset-left);
    width: 100%;
  }

  .mobile-icon {
    display: flex;
  }

  .mobile-icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }
</style>
