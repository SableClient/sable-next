<script lang="ts">
  import CloudXIcon from 'phosphor-svelte/lib/CloudXIcon';

  import { i18n } from '#lib/i18n.js';
  import Tooltip from './Tooltip.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.ts';
  import { NON_SYNCABLE_KEYS, type Preferences } from '#lib/settings/definitions.js';

  interface Props {
    key: keyof Preferences;
  }

  let { key }: Props = $props();
  const isExcluded = $derived(preferences.settingsSync && NON_SYNCABLE_KEYS.has(key));
</script>

{#snippet trigger({ props }: { props: Record<string, unknown> })}
  <div {...props} class="badge-anchor" aria-label={i18n.t('settings.settingExcludedFromSync')}>
    <CloudXIcon />
  </div>
{/snippet}

{#if isExcluded}
  <Tooltip class="badge-anchor" label={i18n.t('settings.settingExcludedFromSync')} {trigger} />
{/if}

<style>
  .badge-anchor {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius-inner);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    height: var(--icon-size-large);
    justify-content: center;
    padding: 0;
    width: var(--icon-size-large);
  }

  .badge-anchor :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
