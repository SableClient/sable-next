<script lang="ts">
  import { onMount } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import { loadAppIcons, setAppIcon } from '#lib/platform/app-icon.js';
  import { isAndroid } from '#lib/platform/os.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  import defaultIcon from '#lib/supporter/app-icons/default.png';
  import propeller from '#lib/supporter/app-icons/propeller.png';
  import agender from '#lib/supporter/app-icons/agender.svg';
  import bisexual from '#lib/supporter/app-icons/bisexual.svg';
  import trans from '#lib/supporter/app-icons/trans.png';
  import transgradient from '#lib/supporter/app-icons/transgradient.svg';
  import intersex from '#lib/supporter/app-icons/intersex.svg';
  import lesbian from '#lib/supporter/app-icons/lesbian.svg';
  import mlm from '#lib/supporter/app-icons/mlm.svg';
  import pluraljourney from '#lib/supporter/app-icons/pluraljourneygradient.svg';
  import pride from '#lib/supporter/app-icons/pride.svg';
  import ukraine from '#lib/supporter/app-icons/ukraine.svg';
  import palestine from '#lib/supporter/app-icons/palestine.svg';
  import cuba from '#lib/supporter/app-icons/cuba.svg';
  import '#lib/ui/primitives/settings-row.css';

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
    pluraljourney,
    pride,
    ukraine,
    palestine,
    cuba,
  };
  let icons = $state.raw<string[]>([]);
  let selected = $state('primary');
  let changing = $state(false);
  let failed = $state(false);
  let android = $state(false);

  onMount(() => {
    android = isAndroid();
    let cancelled = false;
    void loadAppIcons().then((loaded) => {
      if (cancelled || !loaded) return;
      icons = loaded.available;
      selected =
        loaded.current && loaded.available.includes(loaded.current) ? loaded.current : 'primary';
    });
    return () => {
      cancelled = true;
    };
  });

  async function select(icon: string): Promise<void> {
    if (changing || selected === icon) return;
    const previous = selected;
    changing = true;
    failed = false;
    selected = icon;
    try {
      await setAppIcon(icon === 'primary' ? null : icon);
    } catch {
      selected = previous;
      failed = true;
    } finally {
      changing = false;
    }
  }
</script>

{#if icons.length}
  <ul class={['app-icons', { android }]} aria-busy={changing}>
    <SettingsRow id="app-icon" title={i18n.t('settings.appIconTitle')} wide>
      <Select
        bind:value={() => selected, (icon) => void select(icon)}
        disabled={changing}
        aria-label={i18n.t('settings.appIconTitle')}
        items={[...new Set(['primary', ...icons])].map((icon) => ({
          value: icon,
          label: i18n.t(`settings.appIcons.${icon}`, { defaultValue: icon }),
          image: previews[icon],
          imageClass: android ? 'app-icon-image-android' : undefined,
        }))}
      />
    </SettingsRow>
  </ul>
  {#if failed}<div class="settings-form">
      <Alert variant="critical" role="alert">{i18n.t('settings.appIconFailed')}</Alert>
    </div>{/if}
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
