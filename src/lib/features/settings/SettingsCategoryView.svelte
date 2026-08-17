<script lang="ts">
  import { page } from '$app/state';

  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import AppPageShell from '$lib/ui/primitives/AppPageShell.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Select from '$lib/ui/primitives/Select.svelte';
  import SettingsSection from '$lib/ui/primitives/SettingsSection.svelte';
  import StatusBadge from '$lib/ui/primitives/StatusBadge.svelte';
  import Switch from '$lib/ui/primitives/Switch.svelte';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';

  import { buildSettingsLink } from '$lib/features/room/settings-link';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import { syncNativeTelemetryConsent } from '$lib/observability/native-consent';
  import { settingFocusId } from '$lib/settings/registry';
  import type { SettingDefinition, SettingsCategory } from '$lib/settings/registry';
  import { preferences, setPreference } from '$lib/settings/preferences.svelte';
  import type { Preferences } from '$lib/settings/preferences.svelte';

  import NotificationDefaults from '$lib/features/notifications/NotificationDefaults.svelte';
  import PushGateway from '$lib/features/notifications/PushGateway.svelte';
  import StateEventTool from './StateEventTool.svelte';

  interface Props {
    category: SettingsCategory;
  }

  let { category }: Props = $props();

  function gated(setting: SettingDefinition): boolean {
    return setting.gatedBy !== undefined && !preferences[setting.gatedBy];
  }

  let focusId = $derived(page.url.searchParams.get('focus'));
  let highlighted = $state<string | null>(null);
  let copied = $state<string | null>(null);
  /** Sentry reads its consent once, at boot. */
  let reloadPending = $state(false);

  async function copyLink(anchor: string): Promise<void> {
    await navigator.clipboard.writeText(buildSettingsLink(location.origin, category.id, anchor));
    copied = anchor;
    setTimeout(() => {
      if (copied === anchor) copied = null;
    }, 2000);
  }

  $effect(() => {
    const id = focusId;
    if (id === null || !category.items.some((setting) => settingFocusId(setting.key) === id)) {
      return;
    }

    document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    highlighted = id;
    const timer = setTimeout(() => {
      highlighted = null;
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  });
</script>

<AppPageShell
  title={$i18n.t(category.name)}
  description={category.description ? $i18n.t(category.description) : undefined}
  density="compact"
  class="settings-category"
>
  <div class="settings-stack">
    {#if reloadPending}
      <Alert variant="info">
        <p>{$i18n.t('settings.telemetryReloadNotice')}</p>
        <Button
          variant="secondary"
          size="small"
          onclick={() => {
            location.reload();
          }}
        >
          {$i18n.t('settings.telemetryReloadAction')}
        </Button>
      </Alert>
    {/if}

    <section class="settings-card" aria-labelledby={`settings-${category.id}`}>
      <h2 id={`settings-${category.id}`} class="screen-reader-only">{$i18n.t(category.name)}</h2>
      <ul class="settings">
        {#each category.items as setting (setting.key)}
          {@const disabled = setting.unavailable === true || gated(setting)}
          {@const anchor = settingFocusId(setting.key)}
          <li
            id={anchor}
            data-settings-focus={anchor}
            class={[
              'setting-row',
              {
                gated: setting.gatedBy !== undefined,
                disabled,
                highlighted: highlighted === anchor,
              },
            ]}
          >
            <span class="row-icon" aria-hidden="true"><setting.icon /></span>
            <div class="row-copy">
              <div class="row-name">
                <span class="name">{$i18n.t(setting.name)}</span>
                {#if setting.unavailable}
                  <StatusBadge variant="neutral" label={$i18n.t('settings.notAvailableYet')} />
                {/if}
                <span class="row-share">
                  <IconButton
                    variant="ghost"
                    size="small"
                    label={$i18n.t(copied === anchor ? 'settings.linkCopied' : 'settings.copyLink')}
                    onclick={() => void copyLink(anchor)}
                  >
                    {#if copied === anchor}<CheckIcon />{:else}<LinkIcon />{/if}
                  </IconButton>
                </span>
              </div>
              {#if setting.description}
                <p>{$i18n.t(setting.description)}</p>
              {/if}
            </div>
            <div class={['row-control', { wide: setting.type === 'select' }]}>
              {#if setting.type === 'select'}
                {@const key = setting.key}
                <Select
                  {disabled}
                  aria-label={$i18n.t(setting.name)}
                  value={preferences[key]}
                  onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
                    setPreference(key, event.currentTarget.value as Preferences[typeof key]);
                  }}
                >
                  {#each setting.options as option (option.value)}
                    <option value={option.value}>{$i18n.t(option.label)}</option>
                  {/each}
                </Select>
              {:else}
                {@const key = setting.key}
                <Switch
                  {disabled}
                  label={$i18n.t(setting.name)}
                  checked={preferences[key]}
                  onCheckedChange={(checked: boolean) => {
                    setPreference(key, checked);
                    if (key === 'errorReporting' || key === 'sessionReplay') {
                      setPreference('telemetryAsked', true);
                      reloadPending = true;
                    }
                    if (key === 'errorReporting') syncNativeTelemetryConsent(checked);
                  }}
                />
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>

    {#if category.id === 'notifications'}
      <section class="settings-card">
        <NotificationDefaults />
      </section>
      <section class="settings-card">
        <PushGateway />
      </section>
    {/if}

    {#if category.id === 'developer' && preferences.showHiddenEvents}
      <SettingsSection
        title={$i18n.t('settings.stateEventTitle')}
        headingId="settings-state-event"
        class="state-event-section"
      >
        <StateEventTool />
      </SettingsSection>
    {/if}
  </div>
</AppPageShell>

<style>
  :global(.app-page-shell.settings-category) {
    max-width: 56rem;
  }

  .settings-stack {
    display: grid;
    gap: var(--space-2);
  }

  .settings-card {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    overflow: hidden;
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .setting-row {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    min-height: calc(var(--control-height-medium) + var(--space-4));
    padding: var(--space-2) var(--space-3);
  }

  .setting-row + .setting-row {
    border-top: 1px solid var(--sable-bg-container-line);
  }

  .row-icon {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .row-icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .row-copy {
    flex: 1;
    min-width: 0;
  }

  .row-name {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .name {
    font-weight: var(--font-weight-medium);
  }

  .row-copy p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: calc(var(--space-1) / 2) 0 0;
    max-width: 60ch;
  }

  .setting-row.gated .row-icon {
    margin-left: var(--space-3);
  }

  .setting-row.disabled .row-icon,
  .setting-row.disabled .row-copy {
    opacity: 0.55;
  }

  .setting-row.highlighted {
    background: var(--sable-primary-container);
    box-shadow: inset 0.1875rem 0 0 var(--sable-primary-main);
  }

  @media (prefers-reduced-motion: no-preference) {
    .setting-row {
      transition: background-color var(--motion-slow) var(--motion-easing-standard);
    }
  }

  .row-share {
    display: inline-flex;
    flex: 0 0 auto;
  }

  .row-share :global(.sable-icon-button) {
    height: var(--icon-size-large);
    min-height: 0;
    width: var(--icon-size-large);
  }

  .row-share :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .row-control {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
  }

  @media (hover: hover) {
    .row-share {
      opacity: 0;
    }

    .setting-row:hover .row-share,
    .setting-row:focus-within .row-share {
      opacity: 1;
    }
  }

  .row-control.wide {
    min-width: 11rem;
  }

  :global(.state-event-section .settings-section-content) {
    padding: var(--space-3);
  }

  @media (width < 42rem) {
    .setting-row {
      flex-wrap: wrap;
      padding: var(--space-3);
    }

    .row-control {
      justify-content: flex-start;
      padding-left: calc(var(--control-height-medium) + var(--space-3));
      width: 100%;
    }
  }
</style>
