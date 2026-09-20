<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { type as osType } from '@tauri-apps/plugin-os';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

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
    }
  }
</script>

{#if icons.length}
  <div class="app-icons" class:android>
    <h2>{$i18n.t('settings.appIconTitle')}</h2>
    <p>{$i18n.t('settings.appIconDescription')}</p>
    <div
      class="choices"
      role="group"
      aria-label={$i18n.t('settings.appIconTitle')}
      aria-busy={changing}
    >
      {#each ['primary', ...icons] as icon (icon)}
        <Button
          variant={selected === icon ? 'primary' : 'secondary'}
          disabled={changing}
          aria-pressed={selected === icon}
          onclick={() => void select(icon)}
        >
          <span class="choice">
            {#if previews[icon]}<img src={previews[icon]} alt="" width="48" height="48" />{/if}
            <span>{$i18n.t(`settings.appIcons.${icon}`, { defaultValue: icon })}</span>
          </span>
        </Button>
      {/each}
    </div>
    {#if failed}<Alert variant="critical" role="alert">{$i18n.t('settings.appIconFailed')}</Alert
      >{/if}
  </div>
{/if}

<style>
  .app-icons {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  h2,
  p {
    margin: 0;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .choice {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
  }

  img {
    border-radius: 22.5%;
  }

  .android img {
    border-radius: 50%;
  }
</style>
