<script lang="ts">
  import { page } from '$app/state';
  import SettingsSectionContent from '#lib/features/settings/SettingsSectionContent.svelte';
</script>

<SettingsSectionContent section={page.params.section ?? null} />
