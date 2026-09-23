<script lang="ts">
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';

  import type { RegisteredPusherView } from '#src/generated/protocol';
  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import { pushOverride, trimmed } from '#lib/features/notifications/push-config.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';

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
    if (target instanceof HTMLElement) target.closest('li')?.focus({ preventScroll: true });
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
</script>

<section
  bind:this={section}
  class="pushers settings-form"
  aria-labelledby="pushers-heading"
  tabindex="-1"
>
  <div class="pushers-head">
    <h3 id="pushers-heading">{$i18n.t('settings.pushers')}</h3>
    <IconButton
      variant="ghost"
      size="small"
      label={$i18n.t('settings.pushersRefresh')}
      onclick={() => void reload()}
      disabled={loading}
    >
      <ArrowClockwiseIcon />
    </IconButton>
  </div>
  <p class="hint">{$i18n.t('settings.pushersHint')}</p>

  {#if error}
    <Alert variant="warning" role="status">
      <p>{$i18n.t(error)}</p>
    </Alert>
  {/if}

  {#if loading}
    <p class="pushers-empty"><Spinner small label={$i18n.t('a11y.loading')} /></p>
  {:else if pushers.length === 0}
    <p class="pushers-empty">{$i18n.t('settings.pushersEmpty')}</p>
  {:else}
    <ul class="pusher-list">
      {#each pushers as pusher (keyOf(pusher))}
        {@const key = keyOf(pusher)}
        {@const name = nameOf(pusher)}
        <li class="pusher" tabindex="-1">
          <div class="pusher-summary">
            <div class="pusher-info">
              <div class="pusher-name-line">
                <span class="pusher-name">{name}</span>
                {#if pusher.pushkey === ownKey}
                  <StatusBadge variant="primary" label={$i18n.t('settings.pushersThisDevice')} />
                {:else if ownApps.includes(pusher.app_id)}
                  <StatusBadge variant="neutral" label="Sable" />
                {/if}
                {#if pusher.activated !== null}
                  <span
                    title={pusher.activated ? undefined : $i18n.t('settings.pushersPendingHint')}
                  >
                    <StatusBadge
                      variant={pusher.activated ? 'success' : 'warning'}
                      label={$i18n.t(
                        pusher.activated ? 'settings.pushersActive' : 'settings.pushersPending'
                      )}
                    />
                  </span>
                {/if}
              </div>
              <div class="pusher-meta">
                <span class="pusher-kind">{kindLabel(pusher.kind)}</span>
                <button
                  class="pusher-value"
                  type="button"
                  title={pusher.app_id}
                  aria-label={$i18n.t('settings.pushersCopyAppId')}
                  onclick={() => void copyValue(`app\u0000${key}`, pusher.app_id)}
                >
                  {#if copied === `app\u0000${key}`}
                    {$i18n.t('settings.copied')}
                  {:else}
                    <code>{pusher.app_id}</code>
                  {/if}
                </button>
                <button
                  class="pusher-value pusher-key"
                  type="button"
                  title={pusher.pushkey}
                  aria-label={$i18n.t('settings.pushersCopyKey')}
                  onclick={() => void copyValue(`key\u0000${key}`, pusher.pushkey)}
                >
                  {#if copied === `key\u0000${key}`}
                    {$i18n.t('settings.copied')}
                  {:else}
                    <code>{pusher.pushkey}</code>
                  {/if}
                </button>
              </div>
            </div>
            {#if confirming !== key}
              <Button
                variant="danger"
                size="small"
                onclick={(event) => {
                  startRemoval(pusher, event);
                }}
              >
                {$i18n.t('settings.pushersRemove')}
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
                  {$i18n.t('settings.pushersRemove')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  disabled={removing === key}
                  onclick={cancelRemoval}
                >
                  {$i18n.t('settings.cancel')}
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
  .pushers {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
  }

  .pushers-head {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  h3 {
    flex: 1;
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
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

  .pusher-value:hover code {
    text-decoration: underline;
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
</style>
