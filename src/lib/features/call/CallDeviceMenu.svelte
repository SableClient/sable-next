<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';

  import { preferences } from '#lib/settings/preferences.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import {
    DEVICE_PREFERENCE,
    listCallDevices,
    supportsDeviceSelection,
    type CallDevice,
  } from './devices';

  interface Props {
    kinds: readonly MediaDeviceKind[];
    label: string;
    onSelect: (kind: MediaDeviceKind, deviceId: string) => void;
    open?: boolean;
    speaker?: boolean;
  }

  let { kinds, label, onSelect, open = $bindable(false), speaker = false }: Props = $props();

  const HEADING = {
    audioinput: 'settings.callInputDevice',
    audiooutput: 'settings.callOutputDevice',
    videoinput: 'settings.callCameraDevice',
  } as const;

  let devices = $state<CallDevice[]>([]);

  $effect(() => {
    if (!open) return;
    void listCallDevices().then((result) => (devices = result.devices));
  });

  function selected(kind: MediaDeviceKind, deviceId: string): boolean {
    return preferences[DEVICE_PREFERENCE[kind]] === deviceId;
  }
</script>

{#if supportsDeviceSelection()}
  <ActionMenu bind:open {label} side="top" align="center">
    {#snippet trigger({ props })}
      {#if speaker}
        <Button {...props} variant="secondary" aria-label={label}>
          <SpeakerHighIcon aria-hidden="true" />
          <CaretUpIcon aria-hidden="true" weight="bold" />
        </Button>
      {:else}
        <IconButton {...props} variant="ghost" size="small" class="device-caret" {label}>
          <CaretUpIcon weight="bold" />
        </IconButton>
      {/if}
    {/snippet}
    {#each kinds as kind, index (kind)}
      {#if index > 0}<ActionMenuSeparator />{/if}
      <p class="heading">{$i18n.t(HEADING[kind])}</p>
      <ActionMenuItem checked={selected(kind, '')} onSelect={() => onSelect(kind, '')}>
        {$i18n.t('settings.callDeviceSystemDefault')}
      </ActionMenuItem>
      {#each devices.filter((device) => device.kind === kind && device.deviceId !== 'default') as device (device.deviceId)}
        <ActionMenuItem
          checked={selected(kind, device.deviceId)}
          onSelect={() => onSelect(kind, device.deviceId)}
        >
          {device.label || device.deviceId}
        </ActionMenuItem>
      {/each}
    {/each}
  </ActionMenu>
{/if}

<style>
  .heading {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: 0;
    padding: var(--space-150) var(--space-300) var(--space-050);
  }
</style>
