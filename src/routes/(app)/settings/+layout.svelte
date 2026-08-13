<script lang="ts">
  import type { Snippet } from 'svelte';
  import SettingsPanel from '$lib/features/settings/SettingsPanel.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<SettingsPanel>{@render children()}</SettingsPanel>
