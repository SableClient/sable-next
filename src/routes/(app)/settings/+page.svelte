<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { defaultSettingsSection } from '#lib/features/settings/settings-navigation.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  // Phones stay on the section list.
  $effect(() => {
    if (!appLayout.matches) return;
    void goto(resolve(`settings/${defaultSettingsSection()}`), { replaceState: true });
  });
</script>
