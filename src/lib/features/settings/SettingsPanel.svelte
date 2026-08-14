<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import LockIcon from 'phosphor-svelte/lib/LockKeyIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
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
    { id: 'devices' as const, label: 'settings.security', icon: LockIcon },
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
        <Dialog.Description class="screen-reader-only">
          {$i18n.t('settings.dialogDescription')}
        </Dialog.Description>
        <IconButton variant="ghost" size="small" label={$i18n.t('settings.close')} onclick={close}
          ><XIcon /></IconButton
        >
      </div>
      <nav aria-label={$i18n.t('settings.sections')}>
        {#each sections as section (section.id)}
          {@const active = activeSection === section.id}
          <a
            class="sable-selection-layer"
            href={resolve(section.id === 'devices' ? '/settings' : `/settings/${section.id}`)}
            class:active
            aria-current={active ? 'page' : undefined}
            onclick={(event) => {
              if (mode !== 'overlay') return;
              event.preventDefault();
              selectSection(section.id);
            }}
          >
            <span class="icon" aria-hidden="true"><section.icon /></span>
            <span>{$i18n.t(section.label)}</span>
          </a>
        {/each}
      </nav>
      <Button
        block
        class="settings-logout"
        variant="danger"
        aria-label={$i18n.t('settings.logout')}
        onclick={logout}
        ><SignOutIcon /><span class="logout-label">{$i18n.t('settings.logout')}</span></Button
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
    background: var(--sable-surface-container);
    border-right: 1px solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 13.5rem;
    flex-direction: column;
    padding-bottom: var(--space-3);
  }

  .settings-title {
    align-items: center;
    display: flex;
    justify-content: space-between;
    min-height: 4rem;
    padding: var(--space-2) var(--space-3);
  }

  :global(.settings-heading) {
    font-size: var(--font-size-xlarge);
    font-weight: var(--font-weight-bold);
    margin: 0;
    padding: 0;
  }

  nav {
    display: grid;
    gap: 0;
  }

  a {
    align-items: center;
    border-left: 0.1875rem solid transparent;
    color: inherit;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-2);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-3);
    text-decoration: none;
  }

  a:hover {
    background: var(--sable-surface-container-hover);
  }

  a.active {
    border-left-color: var(--sable-primary-main);
    color: var(--sable-bg-on-container);
  }

  .icon {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  a :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.settings-logout) {
    justify-content: flex-start;
    margin: auto var(--space-3) 0;
    width: auto;
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
      border-bottom: 1px solid var(--sable-surface-container-line);
      border-right: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 0;
    }

    .settings-title {
      grid-column: 1 / -1;
      min-height: var(--control-height-medium);
      padding: var(--space-1) var(--space-3);
    }

    :global(.settings-heading) {
      font-size: var(--font-size-large);
      margin: 0;
      padding: 0;
    }

    nav {
      display: flex;
      overflow-x: auto;
    }

    a {
      border-bottom: 0.1875rem solid transparent;
      border-left: 0;
      flex: 0 0 auto;
      min-height: var(--control-height-medium);
      padding: 0 var(--space-3);
    }

    a.active {
      border-bottom-color: var(--sable-primary-main);
    }

    :global(.settings-logout) {
      align-self: center;
      margin: 0 var(--space-2) 0 0;
      width: auto;
    }
  }

  @media (width < 28rem) {
    :global(.settings-logout) {
      min-height: var(--control-height-medium);
      padding-inline: var(--space-2);
    }

    .logout-label {
      display: none;
    }
  }
</style>
