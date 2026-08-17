<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { defaultSettingsSection } from '$lib/features/settings/settings-navigation';
  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  // Phones stay on the section list.
  $effect(() => {
    if (!appLayout.matches) return;
    void goto(resolve(`/settings/${defaultSettingsSection()}`), { replaceState: true });
  });
</script>
