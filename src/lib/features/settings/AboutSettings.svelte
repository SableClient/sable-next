<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import { resolve } from '$app/paths';

  import type { HomeserverSoftwareView } from '#src/generated/protocol';
  import { SABLE_DONATE_URL, SABLE_SOURCE_URL } from '#lib/config/links.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import SableBrandMark from '#lib/ui/SableBrandMark.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import BugIcon from 'phosphor-svelte/lib/BugIcon';
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  const core = useCoreClient();
  const version = `v${import.meta.env.VITE_APP_VERSION ?? 'dev'}`;
  const canResetCache = !isTauri();
  let info = $state<{ homeserver: string; server: HomeserverSoftwareView | null } | null>(null);
  let resetting = $state(false);
  let resetFailed = $state(false);

  $effect(() => {
    let cancelled = false;
    void core.commands
      .homeserverInfo()
      .then((next) => {
        if (!cancelled) info = next;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  });

  async function resetCaches(): Promise<void> {
    resetting = true;
    resetFailed = false;
    try {
      await core.resetCaches();
      window.location.reload();
    } catch {
      resetting = false;
      resetFailed = true;
    }
  }
</script>

<div class="about-page">
  <header class="product">
    <SableBrandMark class="about-logo" />
    <div>
      <div class="product-name">
        <h1>Sable</h1>
        <span>{version}</span>
      </div>
      <p>{$i18n.t('settings.aboutTagline')}</p>
      <div class="product-actions">
        <LinkButton href={SABLE_SOURCE_URL} target="_blank" rel="noopener noreferrer" size="small">
          <CodeIcon aria-hidden="true" />
          {$i18n.t('settings.aboutSource')}
        </LinkButton>
        <LinkButton
          href={SABLE_DONATE_URL}
          target="_blank"
          rel="noopener noreferrer"
          variant="danger"
          size="small"
        >
          <HeartIcon aria-hidden="true" />
          {$i18n.t('settings.aboutSupport')}
        </LinkButton>
      </div>
    </div>
  </header>

  {#if info}
    <SettingsSection title={$i18n.t('settings.aboutHomeserver')} headingId="about-homeserver">
      <ul class="settings">
        <SettingsRow
          title={$i18n.t('settings.aboutHomeserverUrl')}
          description={$i18n.t('settings.aboutHomeserverUrlHint')}
          icon={InfoIcon}
        >
          <span class="value">{info.homeserver.replace(/\/+$/, '')}</span>
        </SettingsRow>
        <SettingsRow title={$i18n.t('settings.aboutHomeserverSoftware')} icon={InfoIcon}>
          <span class="value"
            >{info.server?.name ?? $i18n.t('settings.aboutHomeserverUnknown')}</span
          >
        </SettingsRow>
        <SettingsRow title={$i18n.t('settings.aboutHomeserverVersion')} icon={InfoIcon}>
          <span class="value"
            >{info.server?.version ?? $i18n.t('settings.aboutHomeserverUnknown')}</span
          >
        </SettingsRow>
      </ul>
    </SettingsSection>
  {/if}

  <SettingsSection title={$i18n.t('settings.aboutOptions')} headingId="about-options">
    <ul class="settings">
      <SettingsRow
        title={$i18n.t('settings.aboutReportIssue')}
        description={$i18n.t('settings.aboutReportIssueHint')}
        icon={BugIcon}
      >
        <LinkButton href={resolve('bugreport')} size="small">
          {$i18n.t('settings.aboutReport')}
        </LinkButton>
      </SettingsRow>
      {#if canResetCache}
        <SettingsRow
          title={$i18n.t('settings.aboutResetCache')}
          description={$i18n.t('settings.aboutResetCacheHint')}
          icon={TrashIcon}
        >
          <Button size="small" loading={resetting} onclick={resetCaches}>
            {$i18n.t('settings.aboutReset')}
          </Button>
        </SettingsRow>
        {#if resetFailed}
          <li class="error" role="alert">{$i18n.t('settings.aboutResetFailed')}</li>
        {/if}
      {/if}
    </ul>
  </SettingsSection>
</div>

<style>
  .about-page {
    display: grid;
    gap: var(--space-500);
    margin: 0 auto;
    max-width: 52rem;
    padding: var(--page-gutter);
  }

  .product {
    align-items: flex-start;
    display: flex;
    gap: var(--space-400);
  }

  :global(.about-logo) {
    flex: 0 0 auto;
    height: 3.75rem;
    width: 3.75rem;
  }

  .product > div {
    min-width: 0;
  }

  .product-name,
  .product-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .product-name span,
  p,
  .value {
    color: var(--surface-var-on-container);
  }

  p {
    margin: var(--space-200) 0 var(--space-300);
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .value {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
  }

  .error {
    color: var(--crit-main);
    margin: 0;
  }
</style>
