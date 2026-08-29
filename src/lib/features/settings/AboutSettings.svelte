<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import { resolve } from '$app/paths';

  import type { HomeserverSoftwareView } from '#src/generated/HomeserverSoftwareView';
  import { SABLE_DONATE_URL, SABLE_SOURCE_URL } from '#lib/config/links.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import SableBrandMark from '#lib/ui/SableBrandMark.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
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
  let confirmOpen = $state(false);
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
    confirmOpen = false;
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
          <Button variant="danger" size="small" onclick={() => (confirmOpen = true)}>
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

<DialogFrame
  bind:open={confirmOpen}
  variant="verification"
  label={$i18n.t('settings.aboutResetCacheConfirm')}
>
  <div class="reset">
    <h2>{$i18n.t('settings.aboutResetCacheConfirm')}</h2>
    <p>{$i18n.t('settings.aboutResetCacheConfirmHint')}</p>
    <div class="actions">
      <Button variant="ghost" onclick={() => (confirmOpen = false)}>
        {$i18n.t('timeline.cancel')}
      </Button>
      <Button variant="danger" loading={resetting} onclick={resetCaches}>
        {$i18n.t('settings.aboutReset')}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .about-page {
    display: grid;
    gap: var(--space-4);
    margin: 0 auto;
    max-width: 52rem;
    padding: var(--page-gutter);
  }

  .product {
    align-items: flex-start;
    display: flex;
    gap: var(--space-3);
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
    gap: var(--space-2);
  }

  h1 {
    font-size: var(--font-size-xlarge);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .product-name span,
  p,
  .value {
    color: var(--sable-surface-var-on-container);
  }

  p {
    margin: var(--space-1) 0 var(--space-2);
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

  .reset {
    display: grid;
    gap: var(--space-2);
    width: min(27rem, calc(100vw - 2rem));
  }

  .reset h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .reset p {
    margin: 0;
  }

  .error {
    color: var(--sable-crit-main);
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
    margin-top: var(--space-1);
  }
</style>
