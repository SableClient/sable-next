<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { settingsCategories } from '$lib/settings/registry';
  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  // Phones stay on the section list.
  $effect(() => {
    if (!appLayout.matches) return;
    void goto(resolve(`/settings/${settingsCategories[0].id}`), { replaceState: true });
  });
</script>
