<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  import { callDebug } from './call-debug.svelte.js';

  interface Props {
    overlay?: boolean;
  }

  let { overlay = false }: Props = $props();

  const REQUESTED_LABELS = {
    auto: 'settings.callModeAuto',
    legacy: 'settings.callModeLegacy',
    compatibility: 'settings.callModeCompatibility',
    matrix_2: 'settings.callModeMatrix2',
  } as const;

  const debug = $derived(callDebug.current);

  const yesNo = (value: boolean | undefined): string =>
    value === undefined ? '-' : i18n.t(value ? 'settings.developerYes' : 'settings.developerNo');
</script>

{#if debug}
  <dl class={['debug', { overlay }]} aria-label={i18n.t('call.debugLabel')}>
    <dt>{i18n.t('call.debugMode')}</dt>
    <dd>{i18n.t(`call.debugModes.${debug.mode}`)}</dd>
    <dt>{i18n.t('call.debugRequested')}</dt>
    <dd>{i18n.t(REQUESTED_LABELS[debug.requested])}</dd>
    <dt>{i18n.t('call.debugReason')}</dt>
    <dd>{debug.reason ? i18n.t(`call.debugReasons.${debug.reason}`) : '-'}</dd>
    <dt>{i18n.t('call.debugSticky')}</dt>
    <dd>{yesNo(debug.stickyAvailable)}</dd>
    <dt>{i18n.t('call.debugPeers')}</dt>
    <dd>
      {debug.peerModes.length > 0
        ? debug.peerModes.map((mode) => i18n.t(`call.debugModes.${mode}`)).join(', ')
        : i18n.t('call.debugNoPeers')}
    </dd>
    <dt>{i18n.t('call.debugTransport')}</dt>
    <dd>{i18n.t(`call.debugTransports.${debug.transport}`)}</dd>
    <dt>{i18n.t('call.debugBackends')}</dt>
    <dd>{debug.backendCount}</dd>
    <dt>{i18n.t('call.debugEncrypted')}</dt>
    <dd>{yesNo(debug.encrypted)}</dd>
  </dl>
{/if}

<style>
  .debug {
    column-gap: var(--space-200);
    display: grid;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    grid-template-columns: auto auto;
    margin: 0;
  }

  .debug.overlay {
    backdrop-filter: blur(0.5rem);
    background: var(--tile-scrim);
    border-radius: var(--radii-300);
    color: var(--picker-white);
    inset: calc(var(--space-200) + var(--control-height-300) + var(--space-200)) auto auto
      var(--space-200);
    padding: var(--space-100) var(--space-200);
    pointer-events: none;
    position: absolute;
  }

  dt {
    opacity: var(--opacity-secondary);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
    text-align: end;
  }
</style>
