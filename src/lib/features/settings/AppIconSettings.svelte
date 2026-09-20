<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { type as osType } from '@tauri-apps/plugin-os';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  import defaultIcon from './app-icons/default.png';
  import propeller from './app-icons/propeller.png';
  import agender from './app-icons/agender.svg';
  import bisexual from './app-icons/bisexual.svg';
  import trans from './app-icons/trans.png';
  import transgradient from './app-icons/transgradient.svg';
  import intersex from './app-icons/intersex.svg';
  import lesbian from './app-icons/lesbian.svg';
  import mlm from './app-icons/mlm.svg';
  import pride from './app-icons/pride.svg';

  const previews: Record<string, string> = {
    primary: defaultIcon,
    propeller,
    agender,
    bisexual,
    trans,
    transgradient,
    intersex,
    lesbian,
    mlm,
    pride,
  };
  let icons = $state<string[]>([]);
  let selected = $state('primary');
  let changing = $state(false);
  let failed = $state(false);
  let selectVersion = $state(0);
  let android = $state(false);

  onMount(() => {
    if (!isTauri() || !['android', 'ios'].includes(osType())) return;
    android = osType() === 'android';
    let cancelled = false;
    void Promise.all([
      invoke<string[]>('plugin:app-icon|get_available_icons'),
      invoke<string | null>('plugin:app-icon|get_current_icon'),
    ])
      .then(([available, current]) => {
        if (cancelled) return;
        icons = available;
        selected = current && available.includes(current) ? current : 'primary';
      })
      .catch(() => {
        // Hide the picker if the plugin is unavailable.
      });
    return () => {
      cancelled = true;
    };
  });

  async function select(icon: string): Promise<void> {
    if (changing || selected === icon) return;
    changing = true;
    failed = false;
    try {
      await invoke('plugin:app-icon|set_icon', {
        request: { icon: icon === 'primary' ? null : icon },
      });
      selected = icon;
    } catch {
      failed = true;
    } finally {
      changing = false;
      selectVersion += 1;
    }
  }
</script>

{#if icons.length}
  <ul class="app-icons" class:android aria-busy={changing}>
    <SettingsRow
      title={$i18n.t('settings.appIconTitle')}
      description={$i18n.t('settings.appIconDescription')}
      wide
    >
      {#key selectVersion}
        <Select
          value={selected}
          disabled={changing}
          aria-label={$i18n.t('settings.appIconTitle')}
          items={['primary', ...icons].map((icon) => ({
            value: icon,
            label: $i18n.t(`settings.appIcons.${icon}`, { defaultValue: icon }),
            image: previews[icon],
            imageClass: android ? 'app-icon-image-android' : undefined,
          }))}
          onValueChange={(icon) => void select(icon)}
        />
      {/key}
    </SettingsRow>
  </ul>
  {#if failed}<Alert variant="critical" role="alert">{$i18n.t('settings.appIconFailed')}</Alert
    >{/if}
{/if}

<style>
  .app-icons {
    margin: 0;
    padding: 0;
  }

  :global(.app-icon-image-android) {
    border-radius: 50%;
  }
</style>
