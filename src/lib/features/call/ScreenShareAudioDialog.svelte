<script lang="ts">
  import AppWindowIcon from 'phosphor-svelte/lib/AppWindowIcon';
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import { Dialog } from 'bits-ui';

  import { i18n } from '#lib/i18n.js';
  import {
    lastScreenAudioChoice,
    listScreenAudioApps,
    screenAudioPicksMany,
    screenAudioAppLabel,
    screenAudioSystemSupported,
    screenAudioCanExclude,
  } from '#lib/platform/screen-audio.js';
  import { electronBridge } from '#lib/platform/electron.js';
  import type { ScreenAudioListing } from '#lib/platform/screen-audio-types.js';
  import type { ScreenAudioChoice } from '#lib/platform/screen-audio-stream.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import '#lib/ui/primitives/dialog-body.css';

  type Kind = ScreenAudioChoice['kind'];

  interface Props {
    onShare: (choice: ScreenAudioChoice) => void;
    onCancel: () => void;
  }

  let { onShare, onCancel }: Props = $props();

  const many = screenAudioPicksMany();
  const linuxElectron = electronBridge()?.platform === 'linux';
  const last = lastScreenAudioChoice();
  const systemSupported = screenAudioSystemSupported();
  let kind = $state<Kind>(last.kind === 'system' && !systemSupported ? 'none' : last.kind);
  let excluded = $state<string[]>(last.kind === 'system' ? last.exclude : []);
  let included = $state<string[]>(last.kind === 'apps' ? last.include : []);
  let playing = $state.raw<string[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let backend = $state<ScreenAudioListing['status']>('available');
  let labels = $state.raw<Record<string, string>>({});
  let workaround = $state(last.kind !== 'none' && last.workaround === true);

  let picked = $derived(kind === 'system' ? excluded : included);
  let apps = $derived([...new Set([...playing, ...picked])].sort((a, b) => a.localeCompare(b)));
  let available = $derived(backend === 'available' || backend === 'pipewire-pulse-missing');
  let ready = $derived(
    kind === 'none' ||
      (!loading && !failed && available && (kind !== 'apps' || included.length > 0))
  );
  let listed = $derived(kind === 'apps' || (kind === 'system' && screenAudioCanExclude()));

  let options = $derived(
    [
      {
        value: 'none' as const,
        label: i18n.t('call.screenAudioNone'),
        hint: i18n.t('call.screenAudioNoneHint'),
        icon: SpeakerSlashIcon,
      },
      {
        value: 'system' as const,
        label: i18n.t('call.screenAudioSystem'),
        hint: i18n.t('call.screenAudioSystemHint'),
        icon: SpeakerHighIcon,
      },
      {
        value: 'apps' as const,
        label: i18n.t(many ? 'call.screenAudioApps' : 'call.screenAudioAppsOne'),
        hint: i18n.t(many ? 'call.screenAudioAppsHint' : 'call.screenAudioAppsOneHint'),
        icon: AppWindowIcon,
      },
    ].filter((option) => option.value !== 'system' || systemSupported)
  );

  async function refresh(): Promise<void> {
    loading = true;
    failed = false;
    try {
      const result = await listScreenAudioApps();
      backend = result.status;
      playing = result.apps.map((app) => app.id);
      labels = Object.fromEntries(result.apps.map((app) => [app.id, app.label]));
    } catch (error) {
      console.warn('[sable call] could not list apps playing audio', error);
      failed = true;
    } finally {
      loading = false;
    }
  }

  let requested = false;
  $effect(() => {
    if (!listed || requested) return;
    requested = true;
    void refresh();
  });

  function toggle(app: string): void {
    const next = !many
      ? [app]
      : picked.includes(app)
        ? picked.filter((name) => name !== app)
        : [...picked, app];
    if (kind === 'system') excluded = next;
    else included = next;
  }

  function share(): void {
    if (!ready) return;
    const extra = linuxElectron && kind === 'system' && workaround ? { workaround: true } : {};
    if (kind === 'system') onShare({ kind, exclude: $state.snapshot(excluded), ...extra });
    else if (kind === 'apps') onShare({ kind, include: $state.snapshot(included), ...extra });
    else onShare({ kind: 'none' });
  }
</script>

<DialogFrame
  open
  onOpenChange={(next) => {
    if (!next) onCancel();
  }}
  variant="verification"
  label={i18n.t('call.screenAudioTitle')}
  onConfirm={share}
>
  <div class="dialog-body screen-audio">
    <h2>{i18n.t('call.screenAudioTitle')}</h2>
    <Dialog.Description>
      {#snippet child({ props })}
        <p {...props} class="explain">{i18n.t('call.screenAudioExplain')}</p>
      {/snippet}
    </Dialog.Description>

    <OptionCards
      label={i18n.t('call.screenAudioChoice')}
      {options}
      value={kind}
      onSelect={(next) => {
        kind = next;
      }}
    />

    {#if listed}
      <section class="apps" aria-labelledby="screen-audio-apps">
        <header>
          <h3 id="screen-audio-apps">
            {i18n.t(
              kind === 'system'
                ? 'call.screenAudioExclude'
                : many
                  ? 'call.screenAudioInclude'
                  : 'call.screenAudioIncludeOne'
            )}
          </h3>
          <IconButton
            variant="subtle"
            size="small"
            label={i18n.t('call.screenAudioRefresh')}
            {loading}
            onclick={() => void refresh()}
          >
            <ArrowClockwiseIcon />
          </IconButton>
        </header>

        {#if failed}
          <Alert variant="critical" role="alert">{i18n.t('call.screenAudioFailed')}</Alert>
        {:else if backend === 'incompatible'}
          <Alert variant="critical" role="alert">{i18n.t('call.screenAudioIncompatible')}</Alert>
        {:else if backend === 'unavailable'}
          <Alert variant="critical" role="alert">{i18n.t('call.screenAudioUnavailable')}</Alert>
        {:else if backend === 'pipewire-pulse-missing'}
          <Alert variant="warning" role="status"
            >{i18n.t('call.screenAudioPipeWirePulseMissing')}</Alert
          >
        {/if}
        {#if loading && apps.length === 0}
          <div class="state"><Spinner small label={i18n.t('call.screenAudioLoading')} /></div>
        {:else if apps.length === 0}
          {#if !failed && available}<p class="state">{i18n.t('call.screenAudioEmpty')}</p>{/if}
        {:else}
          <ul {@attach scrollHint}>
            {#each apps as app (app)}
              <li>
                <label>
                  <input
                    type={many ? 'checkbox' : 'radio'}
                    name="screen-audio-app"
                    checked={picked.includes(app)}
                    onchange={() => {
                      toggle(app);
                    }}
                  />
                  <span class="app-name">{labels[app] ?? screenAudioAppLabel(app)}</span>
                  {#if !playing.includes(app)}
                    <span class="quiet">{i18n.t('call.screenAudioSilent')}</span>
                  {/if}
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if linuxElectron && kind === 'system'}
      <label>
        <input type="checkbox" bind:checked={workaround} />
        {i18n.t('call.screenAudioWorkaround')}
      </label>
      <p class="explain">{i18n.t('call.screenAudioWorkaroundHint')}</p>
    {/if}

    <DialogActions>
      <Button type="button" variant="ghost" onclick={onCancel}>
        {i18n.t('common.cancel')}
      </Button>
      <Button type="submit" disabled={!ready}>
        {i18n.t('common.share')}
      </Button>
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .screen-audio {
    gap: var(--space-300);
    width: min(28rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .explain {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
    margin: 0;
  }

  .apps {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    min-height: 0;
  }

  header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  h3 {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-600);
    margin: 0;
  }

  ul {
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-inner);
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 14rem;
    overflow: auto;
    padding: var(--space-100);
  }

  label {
    align-items: center;
    border-radius: var(--radii-300);
    cursor: pointer;
    display: flex;
    gap: var(--space-200);
    padding: var(--space-150) var(--space-200);
  }

  label:hover,
  label:has(input:focus-visible) {
    background: var(--surface-container-hover);
  }

  input {
    accent-color: var(--primary-main);
    flex: none;
    margin: 0;
  }

  .app-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quiet {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin-inline-start: auto;
  }

  .state {
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    justify-content: center;
    margin: 0;
    padding: var(--space-300);
  }
</style>
