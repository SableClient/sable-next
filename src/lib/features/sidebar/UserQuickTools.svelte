<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { Tooltip } from 'bits-ui';
  import BellIcon from 'phosphor-icons-svelte/IconBellRegular.svelte';
  import ChatsIcon from 'phosphor-icons-svelte/IconChatsRegular.svelte';
  import GearIcon from 'phosphor-icons-svelte/IconGearRegular.svelte';
  import MagnifyingGlassIcon from 'phosphor-icons-svelte/IconMagnifyingGlassRegular.svelte';

  interface Props {
    mobile?: boolean;
    compact?: boolean;
    onNavigate?: (href: string) => void;
  }

  let { mobile = false, compact = false, onNavigate }: Props = $props();

  const core = useCoreClient();
  let userId = $derived(core.session?.user_id ?? '');
  let initials = $derived(userId.replace(/^@/, '').charAt(0).toUpperCase() || '?');
  let active = $derived(page.url.pathname.startsWith('/profile'));
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
    <a
      class="quick-tool mobile-tool"
      class:active
      href={resolve('/profile')}
      onclick={() => onNavigate?.('/profile')}
      aria-current={active ? 'page' : undefined}
    >
      <span class="avatar" aria-hidden="true">{initials}</span>
      <span>{$i18n.t('nav.account')}</span>
    </a>
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
      {#snippet profileTrigger({ props }: { props: Record<string, unknown> })}
        <a
          {...props}
          class="quick-tool compact-tool"
          class:active
          href={resolve('/profile')}
          aria-label={$i18n.t('nav.profile')}
          aria-current={active ? 'page' : undefined}
        >
          <span class="avatar" aria-hidden="true">{initials}</span>
        </a>
      {/snippet}
      <Tooltip.Root>
        <Tooltip.Trigger child={profileTrigger} />
        <Tooltip.Content class="tooltip" side="right" sideOffset={8}
          >{$i18n.t('nav.profile')}</Tooltip.Content
        >
      </Tooltip.Root>
    </nav>
  </Tooltip.Provider>
{:else}
  <Tooltip.Provider>
    <nav class="desktop-tools" aria-label={$i18n.t('nav.quickTools')}>
      {#snippet profileTrigger({ props }: { props: Record<string, unknown> })}
        <a
          {...props}
          class="quick-tool desktop-tool"
          class:active
          href={resolve('/profile')}
          aria-label={$i18n.t('nav.profile')}
          aria-current={active ? 'page' : undefined}
        >
          <span class="avatar" aria-hidden="true">{initials}</span>
        </a>
      {/snippet}
      <Tooltip.Root>
        <Tooltip.Trigger child={profileTrigger} />
        <Tooltip.Content class="tooltip" side="top" sideOffset={8}
          >{$i18n.t('nav.profile')}</Tooltip.Content
        >
      </Tooltip.Root>
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
  .quick-tool {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    text-decoration: none;
  }

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

  .compact-tool {
    align-items: center;
    display: flex;
    height: 2.625rem;
    justify-content: center;
    width: 2.625rem;
  }

  .compact-tool :global(svg) {
    height: 1.375rem;
    width: 1.375rem;
  }

  .compact-tool:hover,
  .compact-tool.active {
    background: var(--sable-bg-container-hover);
  }

  .desktop-tool {
    display: flex;
    height: 2.625rem;
    justify-content: center;
    width: 2.625rem;
  }

  .desktop-tool :global(svg) {
    height: 1.375rem;
    width: 1.375rem;
  }

  .desktop-tool:hover,
  .desktop-tool.active {
    background: var(--sable-bg-container-hover);
  }

  .desktop-tool.active {
    color: var(--sable-primary-on-container);
  }

  .avatar {
    align-items: center;
    background: var(--sable-primary-container);
    border-radius: 50%;
    color: var(--sable-primary-on-container);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 2rem;
    justify-content: center;
    text-transform: uppercase;
    width: 2rem;
  }

  .desktop-tool.active .avatar {
    background: var(--sable-primary-on-container);
    color: var(--sable-primary-container);
  }

  .mobile-tool {
    display: grid;
    font-size: var(--font-size-small);
    gap: 0.125rem;
    justify-items: center;
    line-height: 1.1;
    min-width: 3.5rem;
    padding: 0.25rem;
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

  .mobile-tool.active {
    color: var(--sable-primary-on-container);
  }

  .mobile-tool.active .avatar {
    background: var(--sable-primary-container);
  }

  .tooltip {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    color: var(--sable-bg-on-container);
    padding: 0.375rem 0.625rem;
  }

  .quick-tool:focus-visible {
    outline: 3px solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .desktop-tool {
      transition:
        background-color var(--motion-normal) ease,
        transform var(--motion-slow) cubic-bezier(0, 0.8, 0.67, 0.97);
    }

    .desktop-tool:hover {
      transform: translateY(-0.125rem);
    }
  }
</style>
