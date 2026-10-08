<script lang="ts">
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';

  import type { RegisteredPusherView } from '#src/generated/protocol';
  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import { pushOverride, trimmed } from '#lib/features/notifications/push-config.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { currentPushKey, SERVER_PUSHER_KIND, WEBPUSH_APP_ID } from './web-push';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();

  let alive = true;
  let pushers = $state.raw<RegisteredPusherView[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let confirming = $state<string | null>(null);
  let removing = $state<string | null>(null);
  let copied = $state<string | null>(null);
  let ownApps = $state<string[]>([]);
  let ownKey = $state<string | null>(null);
  let section = $state<HTMLElement>();

  function keyOf(pusher: RegisteredPusherView): string {
    return `${pusher.app_id}\u0000${pusher.pushkey}`;
  }

  function nameOf(pusher: RegisteredPusherView): string {
    const name = pusher.device_display_name?.trim();
    return name !== undefined && name !== '' ? name : pusher.app_id;
  }

  function kindLabel(kind: string | null): string {
    if (kind === 'email') return t('settings.pushersKindEmail');
    if (kind === SERVER_PUSHER_KIND) return t('settings.pushersKindServer');
    return kind === null || kind === 'http'
      ? t('settings.pushersKindGateway')
      : t('settings.pushersKindOther');
  }

  async function refreshIdentity(): Promise<void> {
    const config = await runtimeConfig().catch(() => null);
    if (!alive) return;
    const override = trimmed(pushOverride());
    const ids = [
      override.appId,
      config?.push?.webPushAppID,
      config?.push?.nativePushAppID,
      config?.push?.iosPushAppID,
      WEBPUSH_APP_ID,
    ];
    ownApps = [
      ...new Set(ids.filter((id): id is string => id !== undefined && id !== null && id !== '')),
    ];
    const key = await currentPushKey();
    if (alive) ownKey = key;
  }

  async function reload(): Promise<void> {
    try {
      const next = await core.commands.webPushers();
      if (!alive) return;
      pushers = next;
      error = null;
    } catch (cause) {
      console.warn('[sable notifications] loading pushers failed', cause);
      if (alive) error = 'settings.pushersLoadFailed';
    }
  }

  $effect(() => {
    void reload().finally(() => {
      if (alive) loading = false;
    });
    void refreshIdentity();

    return () => {
      alive = false;
    };
  });

  function holdFocus(event: Event): void {
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
      (target.closest('li') ?? section)?.focus({ preventScroll: true });
    }
  }

  function startRemoval(pusher: RegisteredPusherView, event: Event): void {
    holdFocus(event);
    confirming = keyOf(pusher);
  }

  function cancelRemoval(event: Event): void {
    holdFocus(event);
    confirming = null;
  }

  async function copyValue(id: string, value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    copied = id;
    setTimeout(() => {
      if (copied === id) copied = null;
    }, 2000);
  }

  async function remove(pusher: RegisteredPusherView): Promise<void> {
    if (removing !== null) return;
    const key = keyOf(pusher);
    removing = key;
    error = null;
    try {
      await core.commands.removePusher(pusher.pushkey, pusher.app_id);
      if (!alive) return;
      section?.focus({ preventScroll: true });
      confirming = null;
      await reload();
    } catch (cause) {
      console.warn('[sable notifications] removing a pusher failed', cause);
      if (alive) error = 'settings.pushersRemoveFailed';
    } finally {
      if (alive) removing = null;
    }
  }

  async function removeAll(): Promise<void> {
    if (removing !== null || pushers.length === 0) return;
    removing = 'all';
    error = null;
    const removed: string[] = [];
    let failed = false;
    for (const pusher of [...pushers]) {
      try {
        await core.commands.removePusher(pusher.pushkey, pusher.app_id);
        removed.push(keyOf(pusher));
      } catch (cause) {
        console.warn('[sable notifications] removing a pusher failed', cause);
        failed = true;
      }
    }
    if (!alive) return;
    section?.focus({ preventScroll: true });
    confirming = null;
    pushers = pushers.filter((pusher) => !removed.includes(keyOf(pusher)));
    await reload();
    if (alive) {
      if (failed) error = 'settings.pushersRemoveAllFailed';
      removing = null;
    }
  }
</script>

<section
  bind:this={section}
  class="pushers settings-form"
  aria-labelledby="pushers-heading"
  tabindex="-1"
>
  <div class="pushers-head">
    <div class="settings-heading-row">
      <h3 id="pushers-heading" data-settings-outline>{$i18n.t('settings.pushers')}</h3>
      <SettingsAnchorLink anchor="pushers-heading" />
    </div>
    {#if pushers.length > 0 && confirming !== 'all'}
      <Button
        variant="danger"
        size="small"
        disabled={loading || removing !== null}
        onclick={(event) => {
          holdFocus(event);
          confirming = 'all';
        }}
      >
        {$i18n.t('settings.pushersRemoveAll')}
      </Button>
    {/if}
    <IconButton
      variant="ghost"
      size="small"
      label={$i18n.t('settings.pushersRefresh')}
      onclick={() => void reload()}
      disabled={loading || removing !== null}
    >
      <ArrowClockwiseIcon />
    </IconButton>
  </div>
  <p class="hint settings-description">{$i18n.t('settings.pushersHint')}</p>

  {#if confirming === 'all'}
    <form
      class="pusher-confirm"
      onsubmit={(event) => {
        event.preventDefault();
        void removeAll();
      }}
    >
      <span>{$i18n.t('settings.pushersConfirmAll')}</span>
      <div class="pusher-confirm-actions">
        <Button type="submit" variant="danger" size="small" loading={removing === 'all'}>
          {$i18n.t('settings.pushersRemoveAll')}
        </Button>
        <Button variant="ghost" size="small" disabled={removing !== null} onclick={cancelRemoval}>
          {$i18n.t('common.cancel')}
        </Button>
      </div>
    </form>
  {/if}

  {#if error}
    <Alert variant="warning" role="status">
      <p>{$i18n.t(error)}</p>
    </Alert>
  {/if}

  {#if loading}
    <p class="pushers-empty"><Spinner small label={$i18n.t('a11y.loading')} /></p>
  {:else if pushers.length === 0 && error !== 'settings.pushersLoadFailed'}
    <p class="pushers-empty">{$i18n.t('settings.pushersEmpty')}</p>
  {:else}
    <ul class="pusher-list">
      {#each pushers as pusher (keyOf(pusher))}
        {@const key = keyOf(pusher)}
        {@const name = nameOf(pusher)}
        {@const gateway = pusher.gateway}
        <li class="pusher" tabindex="-1">
          <div class="pusher-summary">
            <div class="pusher-info">
              <div class="pusher-name-line">
                <span class="pusher-name">{name}</span>
                {#if pusher.pushkey === ownKey}
                  <StatusBadge variant="primary" label={$i18n.t('settings.currentDevice')} />
                {:else if ownApps.includes(pusher.app_id)}
                  <StatusBadge variant="neutral" label="Sable" />
                {/if}
                {#if pusher.activated !== null}
                  {@const activationLabel = $i18n.t(
                    pusher.activated ? 'settings.pushersActive' : 'settings.pushersPending'
                  )}
                  <Tooltip
                    label={$i18n.t('settings.pushersPendingHint')}
                    disabled={pusher.activated}
                  >
                    {#snippet trigger({ props })}
                      <span {...props}>
                        <StatusBadge
                          variant={pusher.activated ? 'success' : 'warning'}
                          label={activationLabel}
                        />
                      </span>
                    {/snippet}
                  </Tooltip>
                {/if}
              </div>
              <div class="pusher-meta">
                <span class="pusher-kind">{kindLabel(pusher.kind)}</span>
                <Tooltip label={pusher.app_id} multiline>
                  {#snippet trigger({ props })}
                    <button
                      {...props}
                      class="pusher-value"
                      type="button"
                      aria-label={$i18n.t('settings.pushersCopyAppId')}
                      onclick={() => void copyValue(`app\u0000${key}`, pusher.app_id)}
                    >
                      {#if copied === `app\u0000${key}`}
                        {$i18n.t('common.copied')}
                      {:else}
                        <code>{pusher.app_id}</code>
                      {/if}
                    </button>
                  {/snippet}
                </Tooltip>
                <Tooltip label={pusher.pushkey} multiline>
                  {#snippet trigger({ props })}
                    <button
                      {...props}
                      class="pusher-value pusher-key"
                      type="button"
                      aria-label={$i18n.t('settings.pushersCopyKey')}
                      onclick={() => void copyValue(`key\u0000${key}`, pusher.pushkey)}
                    >
                      {#if copied === `key\u0000${key}`}
                        {$i18n.t('common.copied')}
                      {:else}
                        <code>{pusher.pushkey}</code>
                      {/if}
                    </button>
                  {/snippet}
                </Tooltip>
              </div>
              {#if gateway !== null}
                <Tooltip label={gateway} multiline>
                  {#snippet trigger({ props })}
                    <button
                      {...props}
                      class="pusher-gateway"
                      type="button"
                      aria-label={$i18n.t(
                        copied === `gateway\u0000${key}`
                          ? 'common.copied'
                          : 'settings.pushersCopyProvider'
                      )}
                      onclick={() => void copyValue(`gateway\u0000${key}`, gateway)}
                    >
                      <LinkSimpleIcon class="pusher-gateway-link" aria-hidden="true" />
                      <span class="pusher-gateway-copy">
                        <span class="pusher-gateway-label">
                          {$i18n.t(
                            copied === `gateway\u0000${key}`
                              ? 'common.copied'
                              : 'settings.pushersProvider'
                          )}
                        </span>
                        <code>{gateway}</code>
                      </span>
                      {#if copied === `gateway\u0000${key}`}
                        <CheckIcon class="pusher-gateway-action" weight="bold" aria-hidden="true" />
                      {:else}
                        <CopyIcon class="pusher-gateway-action" aria-hidden="true" />
                      {/if}
                    </button>
                  {/snippet}
                </Tooltip>
              {/if}
            </div>
            {#if confirming !== key}
              <Button
                variant="danger"
                size="small"
                disabled={removing !== null}
                onclick={(event) => {
                  startRemoval(pusher, event);
                }}
              >
                {$i18n.t('common.remove')}
              </Button>
            {/if}
          </div>

          {#if confirming === key}
            <form
              class="pusher-confirm"
              onsubmit={(event) => {
                event.preventDefault();
                void remove(pusher);
              }}
            >
              <span>{$i18n.t('settings.pushersConfirmTitle', { name })}</span>
              <div class="pusher-confirm-actions">
                <Button
                  type="submit"
                  variant="danger"
                  size="small"
                  loading={removing === key}
                  aria-label={$i18n.t('settings.pushersRemoveNamed', { name })}
                >
                  {$i18n.t('common.remove')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  disabled={removing === key}
                  onclick={cancelRemoval}
                >
                  {$i18n.t('common.cancel')}
                </Button>
              </div>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .pushers-head {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .pushers-empty {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .pusher-list {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .pusher {
    background: var(--surface-container);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: grid;
    gap: var(--space-200);
    padding: var(--space-200) var(--space-300);
  }

  .pusher-summary {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .pusher-info {
    display: grid;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
  }

  .pusher-name-line {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .pusher-name {
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  .pusher-meta {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    min-width: 0;
  }

  .pusher-value {
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: copy;
    font: inherit;
    margin: 0;
    min-width: 0;
    overflow: hidden;
    padding: 0;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pusher-value code {
    color: inherit;
    font-size: var(--font-size-small);
  }

  .pusher-key {
    flex: 0 1 10rem;
  }

  .pusher-confirm {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .pusher-confirm > span {
    flex: 1;
    min-width: 0;
  }

  .pusher-confirm-actions {
    display: flex;
    gap: var(--space-200);
  }

  .pusher-gateway {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius-inner);
    color: var(--surface-var-on-container);
    cursor: copy;
    display: grid;
    gap: var(--space-200);
    grid-template-columns: auto minmax(0, 1fr) auto;
    margin-top: var(--space-100);
    padding: var(--space-200);
    text-align: left;
    width: 100%;
  }

  .pusher-gateway:hover {
    background: var(--surface-container-hover);
    color: inherit;
  }

  .pusher-gateway:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .pusher-gateway-copy {
    display: grid;
    gap: var(--space-050);
    min-width: 0;
  }

  .pusher-gateway-label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-600);
  }

  .pusher-gateway code {
    color: inherit;
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pusher-value:hover code {
    text-decoration: underline;
  }

  .pusher-gateway :global(.pusher-gateway-link) {
    color: var(--primary-main);
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .pusher-gateway :global(.pusher-gateway-action) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
