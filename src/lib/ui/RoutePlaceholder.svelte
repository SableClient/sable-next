<script lang="ts">
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import { i18n } from '#lib/i18n.js';

  interface Props {
    title?: string;
    titleKey?: string;
  }

  let { title, titleKey }: Props = $props();

  let pageTitle = $derived(title ?? (titleKey ? i18n.t(titleKey) : ''));
</script>

<PageTitle title={pageTitle} />
