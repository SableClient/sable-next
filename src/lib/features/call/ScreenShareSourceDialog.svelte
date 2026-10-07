<script lang="ts">
  import AppWindowIcon from 'phosphor-svelte/lib/AppWindowIcon';
  import MonitorIcon from 'phosphor-svelte/lib/MonitorIcon';
  import { Dialog } from 'bits-ui';
  import { untrack } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import { hdrSharePicksMonitor, type HdrMonitor } from '#lib/platform/hdr-share.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';

  import type { ScreenSource } from './call-transport';

  interface Props {
    monitors: readonly HdrMonitor[];
    onShare: (source: ScreenSource | null) => void;
    onCancel: () => void;
  }

  let { monitors, onShare, onCancel }: Props = $props();

  let choice = $state(
    untrack(() => (monitors.length > 0 ? `hdr:${String(monitors[0]?.index ?? 0)}` : 'picker'))
  );

  const portal = hdrSharePicksMonitor();

  let options = $derived([
    ...(portal ? monitors.slice(0, 1) : monitors).map((monitor) => ({
      value: `hdr:${String(monitor.index)}`,
      label: portal
        ? $i18n.t('call.screenSourceHdrPortal')
        : $i18n.t('call.screenSourceHdr', { name: monitor.name }),
      hint: $i18n.t(portal ? 'call.screenSourceHdrPortalHint' : 'call.screenSourceHdrHint'),
      icon: MonitorIcon,
    })),
    {
      value: 'picker',
      label: $i18n.t('call.screenSourcePicker'),
      hint: $i18n.t('call.screenSourcePickerHint'),
      icon: AppWindowIcon,
    },
  ]);

  function share(): void {
    if (choice === 'picker') {
      onShare(null);
      return;
    }
    onShare({ kind: 'hdr', monitor: Number(choice.slice('hdr:'.length)) });
  }
</script>

<DialogFrame
  open
  onOpenChange={(next) => {
    if (!next) onCancel();
  }}
  variant="verification"
  label={$i18n.t('call.screenSourceTitle')}
  onConfirm={share}
>
  <div class="screen-source">
    <h2>{$i18n.t('call.screenSourceTitle')}</h2>
    <Dialog.Description>
      {#snippet child({ props })}
        <p {...props} class="explain">{$i18n.t('call.screenSourceExplain')}</p>
      {/snippet}
    </Dialog.Description>

    <OptionCards
      label={$i18n.t('call.screenSourceTitle')}
      {options}
      value={choice}
      onSelect={(next) => {
        choice = next;
      }}
    />

    <DialogActions>
      <Button type="button" variant="ghost" onclick={onCancel}>
        {$i18n.t('common.cancel')}
      </Button>
      <Button type="submit">{$i18n.t('common.share')}</Button>
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .screen-source {
    display: grid;
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
</style>
