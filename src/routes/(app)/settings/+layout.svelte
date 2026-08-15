<script lang="ts">
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import SettingsPanel from '$lib/features/settings/SettingsPanel.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<SettingsPanel section={page.params.section ?? null}>{@render children()}</SettingsPanel>
