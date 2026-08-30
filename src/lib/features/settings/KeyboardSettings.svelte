<script lang="ts">
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';

  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import { bindingFromEvent, formatBinding } from '#lib/ui/shortcuts/binding.js';
  import {
    conflictsWith,
    effectiveShortcuts,
    isRebound,
    rebind,
    resetAllBindings,
    resetBinding,
  } from '#lib/ui/shortcuts/bindings.svelte.js';
  import { isMacPlatform } from '#lib/ui/shortcuts/global-shortcuts.js';
  import {
    SHORTCUTS,
    type ShortcutDefinition,
    type ShortcutId,
  } from '#lib/ui/shortcuts/shortcuts.js';

  import '#lib/ui/primitives/settings-row.css';

  const categories: Array<{ id: ShortcutDefinition['category']; labelKey: string }> = [
    { id: 'navigation', labelKey: 'shortcuts.categoryNavigation' },
    { id: 'general', labelKey: 'shortcuts.categoryGeneral' },
    { id: 'room', labelKey: 'shortcuts.categoryRoom' },
  ];

  let capturing = $state<ShortcutId | null>(null);
  let rejected = $state<string | null>(null);
  let isMac = $derived(isMacPlatform());
  let shortcuts = $derived(effectiveShortcuts());
  let rebound = $derived(SHORTCUTS.some((shortcut) => isRebound(shortcut.id)));

  function label(id: ShortcutId): string {
    const shortcut = SHORTCUTS.find((candidate) => candidate.id === id);
    return shortcut ? $i18n.t(shortcut.labelKey) : id;
  }

  function capture(id: ShortcutId, event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.shiftKey && !event.altKey) {
      capturing = null;
      return;
    }

    event.preventDefault();
    const binding = bindingFromEvent(event, isMac);
    if (binding === null) return;

    const taken = conflictsWith(id, binding, isMac);
    if (taken.length > 0) {
      rejected = label(taken[0] as ShortcutId);
      return;
    }

    rebind(id, binding);
    capturing = null;
    rejected = null;
  }
</script>

<AppPageShell
  title={$i18n.t('settings.keyboard')}
  description={$i18n.t('shortcuts.pageDescription')}
  density="compact"
  class="keyboard-settings-page"
>
  <div class="keyboard-settings">
    {#if rejected}
      <Alert variant="warning">{$i18n.t('shortcuts.conflict', { name: rejected })}</Alert>
    {/if}

    {#each categories as category (category.id)}
      {@const items = shortcuts.filter((shortcut) => shortcut.category === category.id)}
      <SettingsSection
        title={$i18n.t(category.labelKey)}
        headingId="shortcuts-settings-{category.id}"
      >
        <ul class="settings-rows">
          {#each items as shortcut (shortcut.id)}
            <SettingsRow title={$i18n.t(shortcut.labelKey)}>
              <div class="binding">
                <Button
                  size="small"
                  variant={capturing === shortcut.id ? 'primary' : 'secondary'}
                  onclick={() => {
                    capturing = capturing === shortcut.id ? null : shortcut.id;
                    rejected = null;
                  }}
                  onkeydown={(event: KeyboardEvent) => {
                    if (capturing === shortcut.id) capture(shortcut.id, event);
                  }}
                >
                  {capturing === shortcut.id
                    ? $i18n.t('shortcuts.pressKeys')
                    : formatBinding(shortcut.binding, isMac)}
                </Button>
                {#if isRebound(shortcut.id)}
                  <IconButton
                    label={$i18n.t('shortcuts.resetOne')}
                    size="small"
                    onclick={() => {
                      resetBinding(shortcut.id);
                      rejected = null;
                    }}
                  >
                    <ArrowCounterClockwiseIcon />
                  </IconButton>
                {/if}
              </div>
            </SettingsRow>
          {/each}
        </ul>
      </SettingsSection>
    {/each}

    {#if rebound}
      <div class="reset-all">
        <Button
          size="small"
          onclick={() => {
            resetAllBindings();
            capturing = null;
            rejected = null;
          }}
        >
          <ArrowCounterClockwiseIcon />
          {$i18n.t('shortcuts.resetAll')}
        </Button>
      </div>
    {/if}
  </div>
</AppPageShell>

<style>
  :global(.app-page-shell.keyboard-settings-page) {
    max-width: 56rem;
  }

  .keyboard-settings {
    display: grid;
    gap: var(--space-400);
  }

  .binding {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .reset-all {
    display: flex;
    justify-content: flex-end;
  }
</style>
