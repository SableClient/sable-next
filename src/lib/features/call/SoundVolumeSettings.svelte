<script lang="ts">
  import { playSound, type NotificationSounds } from '#lib/features/notifications/sound.js';
  import { i18n } from '#lib/i18n.js';
  import {
    PREFERENCE_RANGES,
    preferences,
    setPreference,
    type RangePreference,
  } from '#lib/settings/preferences.svelte.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';

  import '#lib/ui/primitives/settings-row.css';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import HeadphonesIcon from 'phosphor-svelte/lib/HeadphonesIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import MonitorArrowUpIcon from 'phosphor-svelte/lib/MonitorArrowUpIcon';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import type { Component } from 'svelte';

  const CATEGORIES = [
    {
      name: 'ring',
      label: 'sounds.volumeRingCategory',
    },
    {
      name: 'calls',
      label: 'sounds.volumeCallCategory',
    },
  ];

  type Sound = {
    label: string;
    preference: RangePreference;
    icon: Component;
    sound: keyof NotificationSounds;
    category?: string;
  };
  const SOUNDS: Sound[] = [
    {
      label: 'sounds.notification',
      preference: 'soundsNotificationVolume',
      icon: BellIcon,
      sound: 'notification',
    },
    {
      label: 'sounds.camera_on',
      preference: 'soundsCameraOnVolume',
      icon: VideoCameraIcon,
      sound: 'camera_on',
      category: 'calls',
    },
    {
      label: 'sounds.camera_off',
      preference: 'soundsCameraOffVolume',
      icon: VideoCameraSlashIcon,
      sound: 'camera_off',
      category: 'calls',
    },
    {
      label: 'sounds.mic_on',
      preference: 'soundsMicOnVolume',
      icon: MicrophoneIcon,
      sound: 'mic_on',
      category: 'calls',
    },
    {
      label: 'sounds.mic_off',
      preference: 'soundsMicOffVolume',
      icon: MicrophoneSlashIcon,
      sound: 'mic_off',
      category: 'calls',
    },
    {
      label: 'sounds.deafen_on',
      preference: 'soundsDeafenOnVolume',
      icon: SpeakerSlashIcon,
      sound: 'deafen_on',
      category: 'calls',
    },
    {
      label: 'sounds.deafen_off',
      preference: 'soundsDeafenOffVolume',
      icon: HeadphonesIcon,
      sound: 'deafen_off',
      category: 'calls',
    },
    {
      label: 'sounds.screenshare_start',
      preference: 'soundsScreenshareStartVolume',
      icon: MonitorArrowUpIcon,
      sound: 'screenshare_start',
      category: 'calls',
    },
    {
      label: 'sounds.screenshare_stop',
      preference: 'soundsScreenshareStopVolume',
      icon: MonitorArrowUpIcon,
      sound: 'screenshare_stop',
      category: 'calls',
    },
    {
      label: 'sounds.call_join',
      preference: 'soundsCallJoinVolume',
      icon: PhoneIcon,
      sound: 'call_join',
      category: 'calls',
    },
    {
      label: 'sounds.call_leave',
      preference: 'soundsCallLeaveVolume',
      icon: PhoneIcon,
      sound: 'call_leave',
      category: 'calls',
    },
    {
      label: 'sounds.incoming_call',
      preference: 'soundsIncomingCallVolume',
      icon: PhoneIcon,
      sound: 'incoming_call',
      category: 'ring',
    },
    {
      label: 'sounds.outgoing_call',
      preference: 'soundsOutgoingCallVolume',
      icon: PhoneIcon,
      sound: 'outgoing_call',
      category: 'ring',
    },
  ];

  let playing = false;
</script>

{#snippet soundSnippet(sound: Sound)}
  {@const Icon = sound.icon}
  <SettingsRow
    id={`sound-volume-${sound.sound}`}
    title={i18n.t(sound.label)}
    key={sound.preference}
  >
    {#snippet before()}<Icon aria-hidden="true" />{/snippet}
    <div class="range" data-max-range={PREFERENCE_RANGES[sound.preference].max}>
      <Slider
        min={PREFERENCE_RANGES[sound.preference].min}
        max={PREFERENCE_RANGES[sound.preference].max}
        step={0.05}
        label={i18n.t(sound.label)}
        value={preferences[sound.preference]}
        oninput={(value) => {
          preferences[sound.preference] = value;

          if (playing) return;
          playing = true;
          playSound(sound.sound, { blocking: true })
            .catch((error: unknown) => {
              console.warn('[sable notification sound] preview failed', error);
            })
            .finally(() => {
              playing = false;
            });
        }}
        oncommit={(value) => {
          setPreference(sound.preference, value);
        }}
      />

      <label class="form-control range-reading">
        <input
          class="range-input"
          type="number"
          inputmode="numeric"
          min={Math.round(PREFERENCE_RANGES[sound.preference].min * 100)}
          max={Math.round(PREFERENCE_RANGES[sound.preference].max * 100)}
          step={0.05}
          value={Math.round(preferences[sound.preference] * 100)}
          aria-label={i18n.t('settings.rangePercent', { name: i18n.t(sound.label) })}
          onchange={(event) => {
            const typed = Number(event.currentTarget.value) / 100;
            if (event.currentTarget.value !== '' && Number.isFinite(typed)) {
              const { min, max } = PREFERENCE_RANGES[sound.preference];
              const next = Math.min(max, Math.max(min, typed));
              setPreference(sound.preference, next);
            }
            event.currentTarget.value = String(Math.round(preferences[sound.preference] * 100));
          }}
        /><span class="range-suffix" aria-hidden="true">%</span>
      </label>
    </div>
  </SettingsRow>
{/snippet}
<div class="settings-form">
  <div class="device-rows">
    <ul class="settings-rows">
      {#each SOUNDS.filter((sound) => sound.category === undefined) as sound (sound.sound)}
        {@render soundSnippet(sound)}
      {/each}
    </ul>
    {#each CATEGORIES as category (category.name)}
      <h3>{i18n.t(category.label)}</h3>
      <ul class="settings-rows">
        {#each SOUNDS.filter((sound) => sound.category === category.name) as sound (sound.sound)}
          {@render soundSnippet(sound)}
        {/each}
      </ul>
    {/each}
  </div>
</div>

<style>
  .device-rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
  }

  .range[data-max-range='2'] :global(.slider-track) {
    background: linear-gradient(
      to right,
      var(--surface-container) 0%,
      var(--surface-container) 50%,
      var(--crit-container) 70%,
      var(--crit-container) 100%
    );

    &:hover {
      background: linear-gradient(
        to right,
        var(--surface-container-hover) 0%,
        var(--surface-container-hover) 50%,
        var(--crit-container-hover) 70%,
        var(--crit-container-hover) 100%
      );
    }
  }
</style>
