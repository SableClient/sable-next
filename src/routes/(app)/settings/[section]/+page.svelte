<script lang="ts">
  import { page } from '$app/state';
  import DevicesSettings from '$lib/features/settings/DevicesSettings.svelte';
  import { i18n } from '$lib/i18n';
</script>

{#if page.params.section === 'devices'}
  <DevicesSettings />
{:else}
  <main class="placeholder">
    <h2>{$i18n.t('settings.comingSoon')}</h2>
    <p>{$i18n.t('settings.notAvailable')}</p>
  </main>
{/if}

<style>
  .placeholder {
    padding: 2rem;
  }
</style>
