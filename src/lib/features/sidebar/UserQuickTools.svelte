<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import { Tooltip } from 'bits-ui';
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
</script>

{#if mobile}
  <nav class="mobile-tools" aria-label={$i18n.t('nav.quickTools')}>
    {#each mobileTools as item (item.href)}
      {@const toolActive = page.url.pathname.startsWith(item.href)}
      <a
        class="quick-tool mobile-tool"
        class:active={toolActive}
        href={resolve(item.href)}
        onclick={() => onNavigate?.(item.href)}
        aria-current={toolActive ? 'page' : undefined}
      >
        <span class="mobile-icon" aria-hidden="true"><item.icon /></span>
        <span>{$i18n.t(item.label)}</span>
      </a>
    {/each}
    <AccountSwitcher mode="mobile" />
  </nav>
{:else if compact}
  <Tooltip.Provider>
    <nav class="compact-tools" aria-label={$i18n.t('nav.quickTools')}>
      {#each compactTools as item (item.href)}
        {@const toolActive = page.url.pathname.startsWith(item.href)}
        {#snippet trigger({ props }: { props: Record<string, unknown> })}
          <a
            {...props}
            class="quick-tool compact-tool"
            class:active={toolActive}
            href={resolve(item.href)}
            aria-label={$i18n.t(item.label)}
            aria-current={toolActive ? 'page' : undefined}
          >
            <span aria-hidden="true"><item.icon /></span>
          </a>
        {/snippet}
        <Tooltip.Root>
          <Tooltip.Trigger child={trigger} />
          <Tooltip.Content class="tooltip" side="right" sideOffset={8}
            >{$i18n.t(item.label)}</Tooltip.Content
          >
        </Tooltip.Root>
      {/each}
      <AccountSwitcher mode="compact" />
    </nav>
  </Tooltip.Provider>
{:else}
  <Tooltip.Provider>
    <nav class="desktop-tools" aria-label={$i18n.t('nav.quickTools')}>
      <AccountSwitcher mode="desktop" />
      <div class="desktop-tool-actions">
        {#each desktopTools as item (item.href)}
          {@const toolActive = page.url.pathname.startsWith(item.href)}
          {#snippet trigger({ props }: { props: Record<string, unknown> })}
            <a
              {...props}
              class="quick-tool desktop-tool"
              class:active={toolActive}
              href={resolve(item.href)}
              aria-label={$i18n.t(item.label)}
              aria-current={toolActive ? 'page' : undefined}
            >
              <span aria-hidden="true"><item.icon /></span>
            </a>
          {/snippet}
          <Tooltip.Root>
            <Tooltip.Trigger child={trigger} />
            <Tooltip.Content class="tooltip" side="top" sideOffset={8}
              >{$i18n.t(item.label)}</Tooltip.Content
            >
          </Tooltip.Root>
        {/each}
      </div>
    </nav>
  </Tooltip.Provider>
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
    flex: 0 0 4.125rem;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0 0.75rem;
    width: 4.125rem;
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
    height: 1.375rem;
    width: 1.375rem;
  }
</style>
