<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import LockIcon from 'phosphor-svelte/lib/LockKeyIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import RoutePlaceholder from '$lib/ui/RoutePlaceholder.svelte';

  import DevicesSettings from './DevicesSettings.svelte';

  type SettingsSection = 'general' | 'devices';
  type SettingsMode = 'route' | 'overlay';

  interface Props {
    children?: Snippet;
    mode?: SettingsMode;
    open?: boolean;
    onClose?: () => void;
  }

  let { children, mode = 'route', open = $bindable(true), onClose }: Props = $props();
  const core = useCoreClient();

  const sections = [
    { id: 'general' as const, label: 'settings.general', icon: GearIcon },
    { id: 'devices' as const, label: 'settings.devices', icon: LockIcon },
  ] as const;
  let overlaySection = $state<SettingsSection>('devices');
  let activeSection = $derived(
    mode === 'overlay'
      ? overlaySection
      : ((page.params.section as SettingsSection | undefined) ?? 'devices')
  );

  function close(): void {
    if (mode === 'overlay') {
      open = false;
      onClose?.();
      return;
    }

    void goto(resolve('/home'));
  }

  function selectSection(section: SettingsSection): void {
    if (mode === 'overlay') {
      overlaySection = section;
      return;
    }

    void goto(resolve(section === 'devices' ? '/settings' : `/settings/${section}`));
  }

  function logout(): void {
    void core.logout();
  }
</script>

<DialogFrame
  {open}
  variant="settings"
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <div class="settings-shell">
    <aside class="settings-nav" aria-label={$i18n.t('settings.title')}>
      <div class="settings-title">
        <Dialog.Title class="settings-heading">{$i18n.t('settings.title')}</Dialog.Title>
        <IconButton variant="ghost" size="small" label={$i18n.t('settings.close')} onclick={close}
          ><XIcon /></IconButton
        >
      </div>
      <nav>
        {#each sections as section (section.id)}
          {@const active = activeSection === section.id}
          <a
            class="sable-selection-layer"
            href={resolve(section.id === 'devices' ? '/settings' : `/settings/${section.id}`)}
            class:active
            aria-current={active ? 'page' : undefined}
            onclick={(event) => {
              if (mode === 'overlay') event.preventDefault();
              selectSection(section.id);
            }}
          >
            <span class="icon" aria-hidden="true"><section.icon /></span>
            <span>{$i18n.t(section.label)}</span>
          </a>
        {/each}
      </nav>
      <Button block class="settings-logout" variant="danger" onclick={logout}
        >{$i18n.t('settings.logout')}</Button
      >
    </aside>
    <div class="settings-content">
      {#if mode === 'overlay'}
        {#if activeSection === 'devices'}
          <DevicesSettings />
        {:else}
          <RoutePlaceholder titleKey="settings.general" />
        {/if}
      {:else}
        {@render children?.()}
      {/if}
    </div>
  </div>
</DialogFrame>

<style>
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
    padding: var(--space-4) var(--space-3);
  }

  .settings-title {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  :global(.settings-heading) {
    font-size: var(--font-size-xlarge);
    font-weight: var(--font-weight-bold);
    margin: 0 0 var(--space-4);
    padding: 0 var(--space-2);
  }

  nav {
    display: grid;
    gap: 0.25rem;
  }

  a {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-2);
    min-height: var(--control-height-medium);
    padding: var(--space-1) var(--space-2);
    text-decoration: none;
  }

  a:hover {
    background: var(--sable-bg-container-hover);
  }

  a.active {
    color: var(--sable-bg-on-container);
  }

  a :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.settings-logout) {
    justify-content: flex-start;
    margin-top: auto;
  }

  .settings-content {
    height: 100%;
    min-width: 0;
    overflow: auto;
    width: 100%;
  }

  @media (width < 48rem) {
    .settings-shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .settings-nav {
      border-bottom: 1px solid var(--sable-bg-container-line);
      border-right: 0;
      padding: var(--space-3);
    }

    .settings-title {
      min-height: var(--control-height-medium);
    }

    :global(.settings-heading) {
      font-size: var(--font-size-large);
      margin: 0;
      padding: 0;
    }

    nav {
      display: flex;
      margin-top: var(--space-1);
      overflow-x: auto;
    }

    a {
      flex: 0 0 auto;
    }

    :global(.settings-logout) {
      margin-top: var(--space-1);
    }
  }
</style>
