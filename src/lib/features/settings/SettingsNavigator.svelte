<script lang="ts">
  import { resolve } from '$app/paths';
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import LockIcon from 'phosphor-svelte/lib/LockKeyIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import {
    SETTINGS_ACCOUNT_SECTION,
    SETTINGS_DEVICES_SECTION,
    settingsCategories,
  } from '#lib/settings/registry.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { defaultSettingsSection } from './settings-navigation';

  interface Props {
    section: string | null;
    onSelect: (section: string) => void;
    onBack: () => void;
    onClose: () => void;
    content: Snippet<[string]>;
  }

  let { section, onSelect, onBack, onClose, content }: Props = $props();
  const core = useCoreClient();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const sections = [
    { id: SETTINGS_ACCOUNT_SECTION, label: 'settings.account', icon: UserCircleIcon },
    ...settingsCategories.map((category) => ({
      id: category.id,
      label: category.name,
      icon: category.icon,
    })),
    { id: SETTINGS_DEVICES_SECTION, label: 'settings.security', icon: LockIcon },
  ];
  let desktop = $derived(appLayout.matches);
  let openSection = $derived(section ?? (desktop ? defaultSettingsSection() : null));
  let showList = $derived(desktop || section === null);
  let showContent = $derived(desktop || section !== null);
  let activeLabel = $derived(
    sections.find((entry) => entry.id === openSection)?.label ?? 'settings.title'
  );

  function select(event: MouseEvent, nextSection: string): void {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) return;

    event.preventDefault();
    onSelect(nextSection);
  }
</script>

<div class="settings-shell" class:paged={!desktop}>
  <Dialog.Description class="screen-reader-only">
    {$i18n.t('settings.dialogDescription')}
  </Dialog.Description>

  {#if showList}
    <aside class="settings-nav" aria-label={$i18n.t('settings.title')}>
      <div class="settings-title">
        <Dialog.Title class="settings-heading">{$i18n.t('settings.title')}</Dialog.Title>
        <IconButton variant="ghost" size="small" label={$i18n.t('settings.close')} onclick={onClose}
          ><XIcon /></IconButton
        >
      </div>
      <nav aria-label={$i18n.t('settings.sections')}>
        {#each sections as entry (entry.id)}
          {@const active = openSection === entry.id}
          <a
            class="sable-selection-layer"
            href={resolve(`settings/${entry.id}`)}
            class:active
            aria-current={active ? 'page' : undefined}
            onclick={(event) => {
              select(event, entry.id);
            }}
          >
            <span class="icon" aria-hidden="true"><entry.icon /></span>
            <span class="label">{$i18n.t(entry.label)}</span>
            <span class="chevron" aria-hidden="true"><CaretRightIcon /></span>
          </a>
        {/each}
      </nav>
      <Button block class="settings-logout" variant="danger" onclick={() => void core.logout()}>
        <SignOutIcon />
        <span class="logout-label">{$i18n.t('settings.logout')}</span>
      </Button>
    </aside>
  {/if}

  {#if showContent && openSection}
    <div class="settings-content">
      {#if !desktop}
        <div class="settings-title section-bar">
          <IconButton variant="ghost" size="small" label={$i18n.t('settings.back')} onclick={onBack}
            ><ArrowLeftIcon /></IconButton
          >
          <Dialog.Title class="settings-heading">{$i18n.t(activeLabel)}</Dialog.Title>
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('settings.close')}
            onclick={onClose}><XIcon /></IconButton
          >
        </div>
      {/if}
      <div class="settings-scroll">{@render content(openSection)}</div>
    </div>
  {/if}
</div>

<style>
  .settings-shell {
    display: flex;
    height: 100%;
    width: 100%;
  }

  .settings-nav {
    background: var(--sable-surface-container);
    border-right: var(--border-width) solid var(--sable-surface-container-line);
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
    min-height: 0;
    overflow-y: auto;
  }

  a {
    align-items: center;
    border-left: calc(var(--border-width) * 3) solid transparent;
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
    min-height: var(--control-height-medium);
    width: auto;
  }

  .chevron {
    display: none;
  }

  .settings-content {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    width: 100%;
  }

  .settings-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .section-bar {
    background: var(--sable-surface-container);
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    flex: 0 0 auto;
    gap: var(--space-1);
    justify-content: flex-start;
  }

  .section-bar :global(.settings-heading) {
    flex: 1;
    font-size: var(--font-size-large);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .paged .settings-nav {
    border-right: 0;
    flex: 1;
  }

  .paged .settings-title {
    min-height: var(--control-height-large);
  }

  .paged nav {
    flex: 1;
  }

  .paged a {
    border-left: 0;
    min-height: var(--control-height-large);
  }

  .paged .label {
    flex: 1;
    min-width: 0;
  }

  .paged .chevron {
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
  }

  .paged a.active {
    background: var(--sable-surface-container-hover);
  }

  @media (width >= 28rem) {
    :global(.settings-logout) {
      min-height: auto;
    }
  }
</style>
