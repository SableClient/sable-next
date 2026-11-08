<script lang="ts">
  import { onMount } from 'svelte';

  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { listPushDistributors, supportsPushDistributors } from '#lib/platform/push.js';
  import { i18n } from '#lib/i18n.js';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import { deliversNativePush, deliversWebPush } from '#lib/platform/notifications.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import {
    selectedPushDistributor,
    NoDistributorError,
    selectedPushProvider,
    switchPushDistributor,
    switchPushProvider,
    type PushProvider,
  } from './native-push.js';
  import {
    embeddedServer,
    hasCompleteOverride,
    isEmbeddedServerUrl,
    type OverrideProblem,
    overrideProblem,
    type PushOverride,
    pushOverride,
  } from '#lib/notifications/push-config.js';
  import '#lib/ui/primitives/settings-row.css';

  const problemLabels: Record<OverrideProblem, string> = {
    incomplete: 'settings.pushGatewayIncomplete',
    notAUrl: 'settings.pushGatewayNotAUrl',
    notAGateway: 'settings.pushGatewayNotAGateway',
  };

  type Field = {
    key: keyof PushOverride;
    label: string;
    placeholder: string;
  };

  const config = runtimeConfig();
  const core = useCoreClient();
  let android = $state(false);
  const native = deliversNativePush();
  let distributors = $state.raw<string[]>([]);
  let selected = $state('');
  let switching = $state(false);
  let distributorError = $state<'failed' | 'none' | null>(null);
  let provider = $state<PushProvider>('auto');
  let serverPush = $state(false);

  async function refreshServerPush(): Promise<void> {
    if (!(deliversWebPush() || native) || hasCompleteOverride(pushOverride())) {
      serverPush = false;
      return;
    }
    try {
      serverPush = (await core.rpc.push.webPusherSupport()) !== null;
    } catch (error) {
      console.warn('[sable notifications] server push support check failed', error);
      serverPush = false;
    }
  }

  async function refreshDistributors(): Promise<void> {
    try {
      android = await supportsPushDistributors();
      if (!android) return;
      distributors = await listPushDistributors();
      selected = selectedPushDistributor();
      provider = selectedPushProvider();
      distributorError = null;
    } catch (error) {
      console.warn('[sable notifications] listing push distributors failed', error);
      distributorError = 'failed';
    }
  }

  onMount(() => {
    void refreshDistributors();
    void refreshServerPush();
  });

  async function changeDistributor(name: string): Promise<void> {
    if (switching || !name || name === selected) return;
    switching = true;
    distributorError = null;
    try {
      await switchPushDistributor(name, pushOverride(), core.session, core.accounts);
      selected = name;
    } catch (error) {
      console.warn('[sable notifications] switching push distributor failed', error);
      distributorError = 'failed';
      selected = selectedPushDistributor();
    } finally {
      switching = false;
    }
  }

  async function changeProvider(next: string): Promise<void> {
    if (switching || next === provider) return;
    switching = true;
    distributorError = null;
    try {
      await switchPushProvider(next as PushProvider, pushOverride(), core.session, core.accounts);
      provider = next as PushProvider;
      selected = selectedPushDistributor();
    } catch (error) {
      console.warn('[sable notifications] switching push provider failed', error);
      distributorError = error instanceof NoDistributorError ? 'none' : 'failed';
      provider = selectedPushProvider();
    } finally {
      switching = false;
    }
  }

  const fields: Field[] = [
    {
      key: 'pushGatewayUrl',
      label: 'settings.pushGatewayUrl',
      placeholder: 'https://sygnal.example.org/_matrix/push/v1/notify',
    },
    { key: 'pushVapidKey', label: 'settings.pushVapidKey', placeholder: 'BCnS4SbHje…' },
    { key: 'pushAppId', label: 'settings.pushAppId', placeholder: 'org.example.web' },
  ];

  const BLANK: PushOverride = { pushGatewayUrl: '', pushVapidKey: '', pushAppId: '' };

  /** Held locally until Apply, because each write registers a pusher with the
      homeserver. */
  let draft = $state<PushOverride>(pushOverride());

  const saved = $derived(pushOverride());
  const active = $derived(hasCompleteOverride(saved));
  const problem = $derived(overrideProblem(draft));
  const dirty = $derived(fields.some((field) => draft[field.key] !== saved[field.key]));
  const urlRejected = $derived(problem === 'notAUrl' || problem === 'notAGateway');

  let serverDraft = $state(preferences.pushEmbeddedServerUrl);
  const serverDirty = $derived(serverDraft.trim() !== preferences.pushEmbeddedServerUrl);
  const serverRejected = $derived(serverDraft.trim() !== '' && !isEmbeddedServerUrl(serverDraft));

  function applyServer(next: string): void {
    setPreference('pushEmbeddedServerUrl', next.trim());
    serverDraft = preferences.pushEmbeddedServerUrl;
  }

  function apply(next: PushOverride): void {
    for (const field of fields) setPreference(field.key, next[field.key].trim());
    draft = pushOverride();
  }
</script>

<svelte:window
  onfocus={() => {
    if (!switching) {
      void refreshDistributors();
      void refreshServerPush();
    }
  }}
/>

{#if android}
  <section class="gateway settings-form" aria-labelledby="push-distributor">
    <div class="settings-heading-row">
      <h3 id="push-distributor" data-settings-outline>{i18n.t('settings.pushTransport')}</h3>
      <SettingsAnchorLink anchor="push-distributor" />
    </div>
    <p class="hint">{i18n.t('settings.pushTransportHint')}</p>
    <Select
      value={provider}
      items={[
        { value: 'auto', label: i18n.t('settings.pushTransportAuto') },
        { value: 'fcm', label: i18n.t('settings.pushTransportNative') },
        { value: 'unifiedpush', label: i18n.t('settings.pushTransportUnifiedPush') },
        { value: 'embedded', label: i18n.t('settings.pushDistributorBuiltIn') },
      ]}
      aria-label={i18n.t('settings.pushTransport')}
      disabled={switching || core.status !== 'ready'}
      onValueChange={(value) => void changeProvider(value)}
    />
    {#if provider === 'unifiedpush'}
      <p class="hint">{i18n.t('settings.pushDistributorHint')}</p>
      <Select
        bind:value={() => selected, (value) => void changeDistributor(value)}
        items={distributors.map((value) => ({
          value,
          label: value === 'embedded-websocket' ? i18n.t('settings.pushDistributorBuiltIn') : value,
        }))}
        aria-label={i18n.t('settings.pushDistributor')}
        placeholder={i18n.t('settings.pushDistributorChoose')}
        disabled={switching || core.status !== 'ready'}
      />
    {/if}
    {#if provider === 'embedded'}
      <label>
        <span>{i18n.t('settings.pushEmbeddedServer')}</span>
        <TextInput
          bind:value={serverDraft}
          placeholder="https://ntfy.example.org"
          autocomplete="off"
          spellcheck="false"
          aria-invalid={serverRejected ? 'true' : undefined}
        />
      </label>
      {#await config then { push }}
        <p class="hint">
          {i18n.t('settings.pushEmbeddedServerHint', { server: embeddedServer(push) })}
        </p>
      {/await}
      {#if serverRejected}
        <Alert variant="warning" role="status">
          <p>{i18n.t('settings.pushEmbeddedServerInvalid')}</p>
        </Alert>
      {/if}
      <div class="actions">
        <Button
          variant="primary"
          size="small"
          disabled={!serverDirty || serverRejected || switching}
          onclick={() => {
            applyServer(serverDraft);
          }}
        >
          {i18n.t('common.apply')}
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={(preferences.pushEmbeddedServerUrl === '' && !serverDirty) || switching}
          onclick={() => {
            applyServer('');
          }}
        >
          {i18n.t('settings.pushGatewayReset')}
        </Button>
      </div>
    {/if}
    {#if distributorError}
      <Alert variant="critical">
        {i18n.t(
          distributorError === 'none'
            ? 'settings.pushDistributorNone'
            : 'settings.pushDistributorFailed'
        )}
      </Alert>
    {/if}
  </section>
{/if}

<section class="gateway settings-form" aria-labelledby="push-gateway">
  <div class="settings-heading-row">
    <h3 id="push-gateway" data-settings-outline>{i18n.t('settings.pushGateway')}</h3>
    <SettingsAnchorLink anchor="push-gateway" />
  </div>
  <p class="hint settings-description">{i18n.t('settings.pushGatewayHint')}</p>
  {#if android && (provider === 'unifiedpush' || provider === 'embedded')}
    <p class="hint">{i18n.t('settings.pushGatewayUnifiedPush')}</p>
  {/if}

  {#if !deliversWebPush() && !native}
    <Alert variant="info">
      <p>{i18n.t('settings.pushGatewayUnsupported')}</p>
    </Alert>
  {:else if !active && serverPush}
    <p class="hint">{i18n.t('settings.pushGatewayServer')}</p>
  {:else if !active}
    {#await config then { push }}
      {#if push}
        <p class="hint">
          {i18n.t('settings.pushGatewayDefault', { gateway: push.pushNotifyUrl })}
        </p>
      {/if}
    {/await}
  {/if}

  <div class="rows">
    {#each fields as field (field.key)}
      <label>
        <span>{i18n.t(field.label)}</span>
        <TextInput
          bind:value={draft[field.key]}
          placeholder={field.placeholder}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={field.key === 'pushGatewayUrl' && urlRejected ? 'true' : undefined}
        />
      </label>
    {/each}
  </div>

  {#if problem !== null}
    <Alert variant="warning" role="status">
      <p>{i18n.t(problemLabels[problem])}</p>
    </Alert>
  {:else if active}
    <Alert variant="warning" role="status">
      <p>{i18n.t('settings.pushGatewayWarning')}</p>
    </Alert>
  {/if}

  <div class="actions">
    <Button
      variant="primary"
      size="small"
      disabled={!dirty || problem !== null}
      onclick={() => {
        apply(draft);
      }}
    >
      {i18n.t('common.apply')}
    </Button>
    <Button
      variant="secondary"
      size="small"
      disabled={!active && !dirty}
      onclick={() => {
        apply(BLANK);
      }}
    >
      {i18n.t('settings.pushGatewayReset')}
    </Button>
  </div>
</section>

<style>
  .rows {
    display: grid;
    gap: var(--space-300);
  }

  label {
    display: grid;
    gap: var(--space-200);
  }

  label :global(.text-input) {
    width: 100%;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }
</style>
