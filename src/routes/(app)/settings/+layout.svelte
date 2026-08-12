<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import { useCoreClient } from '$lib/core/context';
  import type { Snippet } from 'svelte';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import LockIcon from 'phosphor-svelte/lib/LockKeyIcon';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();

  const sections = [
    { id: 'general', label: 'settings.general', icon: GearIcon },
    { id: 'devices', label: 'settings.devices', icon: LockIcon },
  ] as const;
  let activeSection = $derived(page.params.section ?? 'devices');

  function close(): void {
    void goto(resolve('/home'));
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  function logout(): void {
    void core.logout();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="settings-overlay">
  <button type="button" class="backdrop" aria-label={$i18n.t('settings.close')} onclick={close}
  ></button>
  <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="settings-shell">
      <aside class="settings-nav" aria-label={$i18n.t('settings.title')}>
        <div class="settings-title">
          <h1 id="settings-title">{$i18n.t('settings.title')}</h1>
          <button type="button" class="close" aria-label={$i18n.t('settings.close')} onclick={close}
            >×</button
          >
        </div>
        <nav>
          {#each sections as section (section.id)}
            {@const active = activeSection === section.id}
            <a
              href={resolve(section.id === 'devices' ? '/settings' : `/settings/${section.id}`)}
              class:active
              aria-current={active ? 'page' : undefined}
            >
              <span class="icon" aria-hidden="true"><section.icon /></span>
              <span>{$i18n.t(section.label)}</span>
            </a>
          {/each}
        </nav>
        <button type="button" class="logout" onclick={logout}>{$i18n.t('settings.logout')}</button>
      </aside>
      <div class="settings-content">{@render children()}</div>
    </div>
  </div>
</div>

<style>
  .settings-overlay {
    align-items: center;
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 2rem;
    position: fixed;
    z-index: 20;
  }

  .backdrop {
    background: var(--sable-overlay);
    border: 0;
    inset: 0;
    position: absolute;
    width: 100%;
  }

  .settings-dialog {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-dialog);
    height: min(48rem, calc(100dvh - 4rem));
    max-width: 72rem;
    overflow: hidden;
    position: relative;
    width: 100%;
  }

  .settings-shell {
    display: flex;
    height: 100%;
    width: 100%;
  }

  .settings-nav {
    background: var(--sable-bg-container);
    border-right: 1px solid var(--sable-bg-container-line);
    display: flex;
    flex: 0 0 15rem;
    flex-direction: column;
    padding: 1.5rem 1rem;
  }

  .settings-title {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  h1 {
    font-size: var(--font-size-xlarge);
    margin: 0 0 1.5rem;
    padding: 0 0.75rem;
  }

  .close {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 50%;
    color: inherit;
    cursor: pointer;
    display: flex;
    font-size: 1.75rem;
    height: 2.25rem;
    justify-content: center;
    line-height: 1;
    width: 2.25rem;
  }

  .close:hover {
    background: var(--sable-bg-container-hover);
  }

  nav {
    display: grid;
    gap: 0.25rem;
  }

  .logout {
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-crit-main);
    cursor: pointer;
    font: inherit;
    font-weight: var(--font-weight-medium);
    margin-top: auto;
    padding: 0.75rem;
    text-align: left;
  }

  .logout:hover {
    background: var(--sable-crit-container);
  }

  a {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: 0.75rem;
    padding: 0.75rem;
    text-decoration: none;
  }

  a:hover {
    background: var(--sable-bg-container-hover);
  }

  a.active {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  a :global(svg) {
    height: 1.25rem;
    width: 1.25rem;
  }

  .settings-content {
    height: 100%;
    min-width: 0;
    overflow: auto;
    width: 100%;
  }

  @media (width < 48rem) {
    .settings-overlay {
      padding: 0;
    }

    .settings-dialog {
      border: 0;
      border-radius: 0;
      height: 100dvh;
    }

    .settings-shell {
      display: block;
      overflow: auto;
    }

    .settings-nav {
      border-bottom: 1px solid var(--sable-bg-container-line);
      border-right: 0;
      padding: 1rem;
    }

    .logout {
      margin-top: 0.5rem;
    }

    h1 {
      font-size: var(--font-size-large);
      margin-bottom: 0.75rem;
      padding: 0;
    }

    nav {
      display: flex;
      overflow-x: auto;
    }

    a {
      flex: 0 0 auto;
    }
  }
</style>
