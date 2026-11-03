<script lang="ts">
  import AlertList from '#lib/features/sidebar/AlertList.svelte';
  import { i18n } from '#lib/i18n.js';
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
</script>

<PageTitle title={i18n.t('nav.alerts')} />
<AlertList />
