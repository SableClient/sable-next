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
  import Slider from '#lib/ui/primitives/Slider.svelte';

  import { outputVolume, setOutputVolume } from './participant-volumes.svelte.js';
  import { supportsDeviceSelection, listCallDevices, type CallDevice } from './devices.js';

  let devices = $state<CallDevice[]>([]);
  let denied = $state(false);
  let level = $state(0);
  let testing = $state(false);
  let stopTest: (() => void) | undefined;

  const supported = supportsDeviceSelection();

  const optionsFor = (kind: MediaDeviceKind) => [
    { value: '', label: $i18n.t('settings.callDeviceSystemDefault') },
    ...devices
      .filter((device) => device.kind === kind)
      .map((device) => ({
        value: device.deviceId,
        label: device.label || $i18n.t('settings.callDevicesUnnamed'),
      })),
  ];

  $effect(() => {
    if (!supported) return;
    let cancelled = false;
    void listCallDevices().then((result) => {
      if (cancelled) return;
      devices = result.devices;
      denied = result.denied;
    });
    const refresh = () => {
      void listCallDevices().then((result) => {
        if (!cancelled) devices = result.devices;
      });
    };
    const off = on(navigator.mediaDevices, 'devicechange', refresh);
    return () => {
      cancelled = true;
      off();
    };
  });

  $effect(() => () => stopTest?.());

  async function toggleTest(): Promise<void> {
    if (testing) {
      stopTest?.();
      return;
    }
    const { startInputMeter } = await import('./input-meter');
    const meter = await startInputMeter(preferences.audioInputDevice, (next) => (level = next));
    if (!meter) {
      denied = true;
      return;
    }
    testing = true;
    stopTest = () => {
      meter();
      stopTest = undefined;
      testing = false;
      level = 0;
    };
  }
</script>

{#if !supported}
  <Alert variant="info">{$i18n.t('settings.callDevicesUnsupported')}</Alert>
{:else}
  {#if denied}
    <Alert variant="info">{$i18n.t('settings.callDevicesPermission')}</Alert>
  {/if}

  <div class="device-rows">
    <label class="row">
      <span class="label"
        ><MicrophoneIcon aria-hidden="true" />{$i18n.t('settings.callInputDevice')}</span
      >
      <Select
        items={optionsFor('audioinput')}
        value={preferences.audioInputDevice}
        aria-label={$i18n.t('settings.callInputDevice')}
        onValueChange={(value) => setPreference('audioInputDevice', value)}
      />
    </label>

    <label class="row">
      <span class="label"
        ><SpeakerHighIcon aria-hidden="true" />{$i18n.t('settings.callOutputDevice')}</span
      >
      <Select
        items={optionsFor('audiooutput')}
        value={preferences.audioOutputDevice}
        aria-label={$i18n.t('settings.callOutputDevice')}
        onValueChange={(value) => setPreference('audioOutputDevice', value)}
      />
    </label>

    <label class="row">
      <span class="label"
        ><VideoCameraIcon aria-hidden="true" />{$i18n.t('settings.callCameraDevice')}</span
      >
      <Select
        items={optionsFor('videoinput')}
        value={preferences.videoInputDevice}
        aria-label={$i18n.t('settings.callCameraDevice')}
        onValueChange={(value) => setPreference('videoInputDevice', value)}
      />
    </label>

    <div class="row">
      <span class="label"
        ><SpeakerHighIcon aria-hidden="true" />{$i18n.t('settings.callOutputVolume')}</span
      >
      <div class="control">
        <Slider
          min={0}
          max={1}
          step={0.05}
          label={$i18n.t('settings.callOutputVolume')}
          value={outputVolume()}
          oninput={setOutputVolume}
        />
        <span class="reading">{Math.round(outputVolume() * 100)}%</span>
      </div>
    </div>

    <div class="row">
      <span class="label"
        ><MicrophoneIcon aria-hidden="true" />{$i18n.t('settings.callMicTestLevel')}</span
      >
      <div class="control">
        <div
          class="meter"
          role="meter"
          aria-valuenow={Math.round(level * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={$i18n.t('settings.callMicTestLevel')}
        >
          <div class="fill" style={`inline-size: ${String(Math.round(level * 100))}%`}></div>
        </div>
        <Button variant="secondary" size="small" onclick={() => void toggleTest()}>
          {$i18n.t(testing ? 'settings.callMicTestStop' : 'settings.callMicTest')}
        </Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .device-rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
  }

  .row {
    align-items: center;
    display: grid;
    gap: var(--space-200);
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
  }

  .label {
    align-items: center;
    display: inline-flex;
    gap: var(--space-100);
  }

  .control {
    align-items: center;
    display: flex;
    gap: var(--space-150);
  }

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
