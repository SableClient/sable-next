<script lang="ts">
  import { onMount } from 'svelte';

  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { listPushDistributors, supportsPushDistributors } from '#lib/platform/push.js';
  import { i18n } from '#lib/i18n.js';
  import { deliversNativePush, deliversWebPush } from '#lib/platform/notifications.js';
  import { setPreference } from '#lib/settings/preferences.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { selectedPushDistributor, switchPushDistributor } from './native-push.js';
  import {
    hasCompleteOverride,
    type OverrideProblem,
    overrideProblem,
    type PushOverride,
    pushOverride,
  } from './push-config';

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
  let native = $state(false);
  let distributors = $state<string[]>([]);
  let selected = $state('');
  let switching = $state(false);
  let distributorError = $state(false);

  async function refreshDistributors(): Promise<void> {
    try {
      native = await deliversNativePush();
      android = await supportsPushDistributors();
      if (!android) return;
      distributors = await listPushDistributors();
      selected = selectedPushDistributor();
      distributorError = false;
    } catch {
      distributorError = true;
    }
  }

  onMount(() => {
    void refreshDistributors();
  });

  async function changeDistributor(name: string): Promise<void> {
    if (switching || !name || name === selected) return;
    switching = true;
    distributorError = false;
    try {
      await switchPushDistributor(name, pushOverride(), core.session);
      selected = name;
    } catch {
      distributorError = true;
      selected = selectedPushDistributor();
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

  function apply(next: PushOverride): void {
    for (const field of fields) setPreference(field.key, next[field.key].trim());
    draft = pushOverride();
  }
</script>

<svelte:window
  onfocus={() => {
    if (!switching) void refreshDistributors();
  }}
/>

{#if android}
  <section class="gateway" aria-labelledby="push-distributor">
    <h3 id="push-distributor">{$i18n.t('settings.pushDistributor')}</h3>
    <p class="hint">{$i18n.t('settings.pushDistributorHint')}</p>
    {#key selected + String(switching)}
      <Select
        value={selected}
        items={distributors.map((value) => ({
          value,
          label:
            value === 'embedded-websocket' ? $i18n.t('settings.pushDistributorBuiltIn') : value,
        }))}
        aria-label={$i18n.t('settings.pushDistributor')}
        placeholder={$i18n.t('settings.pushDistributorChoose')}
        disabled={switching || core.status !== 'ready'}
        onValueChange={(value) => void changeDistributor(value)}
      />
    {/key}
    {#if distributorError}
      <Alert variant="critical">{$i18n.t('settings.pushDistributorFailed')}</Alert>
    {/if}
  </section>
{/if}

<section class="gateway" aria-labelledby="push-gateway">
  <h3 id="push-gateway">{$i18n.t('settings.pushGateway')}</h3>
  <p class="hint">{$i18n.t('settings.pushGatewayHint')}</p>

  {#if !deliversWebPush() && !native}
    <Alert variant="info">
      <p>{$i18n.t('settings.pushGatewayUnsupported')}</p>
    </Alert>
  {:else if !active}
    {#await config then { push }}
      {#if push}
        <p class="hint">
          {$i18n.t('settings.pushGatewayDefault', { gateway: push.pushNotifyUrl })}
        </p>
      {/if}
    {/await}
  {/if}

  <div class="rows">
    {#each fields as field (field.key)}
      <label>
        <span>{$i18n.t(field.label)}</span>
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
      <p>{$i18n.t(problemLabels[problem])}</p>
    </Alert>
  {:else if active}
    <Alert variant="warning" role="status">
      <p>{$i18n.t('settings.pushGatewayWarning')}</p>
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
      {$i18n.t('settings.pushGatewayApply')}
    </Button>
    <Button
      variant="secondary"
      size="small"
      disabled={!active && !dirty}
      onclick={() => {
        apply(BLANK);
      }}
    >
      {$i18n.t('settings.pushGatewayReset')}
    </Button>
  </div>
</section>

<style>
  .gateway {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  h3 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

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
    gap: var(--space-300);
  }
</style>
