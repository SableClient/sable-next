<script lang="ts">
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';

  import { on } from 'svelte/events';

  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';

  import { outputVolume, setOutputVolume } from './participant-volumes.svelte.js';
  import {
    supportsDeviceSelection,
    listCallDevices,
    unlockCallDevices,
    type CallDevice,
  } from './devices.js';
  import { microphoneProcessing } from './voice-filter';
  import '#lib/ui/primitives/settings-row.css';

  let devices = $state.raw<CallDevice[]>([]);
  let denied = $state(false);
  let unlockError = $state<string | null>(null);
  let level = $state(0);
  let testing = $state(false);

  const supported = supportsDeviceSelection();
  const SYSTEM_DEFAULT = 'system';

  const optionsFor = (kind: MediaDeviceKind) => [
    { value: SYSTEM_DEFAULT, label: i18n.t('settings.callDeviceSystemDefault') },
    ...devices
      .filter((device) => device.kind === kind)
      .map((device) => ({
        value: device.deviceId,
        label: device.label || i18n.t('settings.unnamedDevice'),
      })),
  ];

  async function refresh(): Promise<void> {
    const result = await listCallDevices();
    devices = result.devices;
    denied = result.denied;
  }

  $effect(() => {
    if (!supported) return;
    void refresh();
    const off = on(navigator.mediaDevices, 'devicechange', () => void refresh());
    return off;
  });

  $effect(() => {
    if (!testing) return;
    const input = preferences.audioInputDevice;
    const playback = { outputDevice: preferences.audioOutputDevice, ...microphoneProcessing() };
    let cancelled = false;
    let stop: (() => void) | null = null;
    void import('./input-meter')
      .then(({ startInputMeter }) =>
        cancelled ? null : startInputMeter(input, (next) => (level = next), playback)
      )
      .then((dispose) => {
        if (cancelled) {
          dispose?.();
          return;
        }
        if (!dispose) {
          testing = false;
          denied = true;
          return;
        }
        stop = dispose;
        void refresh();
      });
    return () => {
      cancelled = true;
      stop?.();
      level = 0;
    };
  });

  async function unlock(): Promise<void> {
    unlockError = await unlockCallDevices();
    await refresh();
  }
</script>

<div class="settings-form">
  {#if !supported}
    <Alert variant="info">{i18n.t('settings.callDevicesUnsupported')}</Alert>
  {:else}
    {#if denied || devices.length === 0}
      <Alert variant="info">
        <p>{i18n.t('settings.callDevicesPermission')}</p>
        <div>
          <Button variant="secondary" size="small" onclick={() => void unlock()}>
            {i18n.t('settings.callDevicesAllow')}
          </Button>
        </div>
        {#if unlockError}
          <p>{i18n.t('settings.callDevicesFailed', { reason: unlockError })}</p>
        {/if}
      </Alert>
    {/if}

    <ul class="settings-rows">
      <SettingsRow
        id="call-input-device"
        title={i18n.t('settings.callInputDevice')}
        key="audioInputDevice"
      >
        {#snippet before()}<MicrophoneIcon aria-hidden="true" />{/snippet}
        <Select
          items={optionsFor('audioinput')}
          value={preferences.audioInputDevice || SYSTEM_DEFAULT}
          aria-label={i18n.t('settings.callInputDevice')}
          onValueChange={(value) =>
            setPreference('audioInputDevice', value === SYSTEM_DEFAULT ? '' : value)}
        />
      </SettingsRow>

      <SettingsRow
        id="call-output-device"
        title={i18n.t('settings.callOutputDevice')}
        key="audioOutputDevice"
      >
        {#snippet before()}<SpeakerHighIcon aria-hidden="true" />{/snippet}
        <Select
          items={optionsFor('audiooutput')}
          value={preferences.audioOutputDevice || SYSTEM_DEFAULT}
          aria-label={i18n.t('settings.callOutputDevice')}
          onValueChange={(value) =>
            setPreference('audioOutputDevice', value === SYSTEM_DEFAULT ? '' : value)}
        />
      </SettingsRow>

      <SettingsRow
        id="call-camera-device"
        title={i18n.t('settings.callCameraDevice')}
        key="videoInputDevice"
      >
        {#snippet before()}<VideoCameraIcon aria-hidden="true" />{/snippet}
        <Select
          items={optionsFor('videoinput')}
          value={preferences.videoInputDevice || SYSTEM_DEFAULT}
          aria-label={i18n.t('settings.callCameraDevice')}
          onValueChange={(value) =>
            setPreference('videoInputDevice', value === SYSTEM_DEFAULT ? '' : value)}
        />
      </SettingsRow>

      <SettingsRow id="call-output-volume" title={i18n.t('settings.callOutputVolume')}>
        {#snippet before()}<SpeakerHighIcon aria-hidden="true" />{/snippet}
        <div class="range">
          <Slider
            min={0}
            max={1}
            step={0.05}
            label={i18n.t('settings.callOutputVolume')}
            value={outputVolume()}
            oninput={setOutputVolume}
          />
          <span class="reading">{Math.round(outputVolume() * 100)}%</span>
        </div>
      </SettingsRow>

      <SettingsRow id="call-mic-test" title={i18n.t('settings.callMicTestLevel')}>
        {#snippet before()}<MicrophoneIcon aria-hidden="true" />{/snippet}
        <div class="range">
          <div
            class="meter"
            role="meter"
            aria-valuenow={Math.round(level * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={i18n.t('settings.callMicTestLevel')}
          >
            <div class="fill" style={`inline-size: ${String(Math.round(level * 100))}%`}></div>
          </div>
          <Button variant="secondary" size="small" onclick={() => (testing = !testing)}>
            {i18n.t(testing ? 'common.stopTest' : 'settings.callMicTest')}
          </Button>
        </div>
      </SettingsRow>
    </ul>
  {/if}
</div>

<style>
  .reading {
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    inline-size: 2.5rem;
    text-align: end;
  }

  .meter {
    background: var(--surface-container);
    block-size: var(--space-200);
    border-radius: var(--radii-300);
    flex: 1;
    overflow: hidden;
  }

  .fill {
    background: var(--primary-main);
    block-size: 100%;
  }
</style>
