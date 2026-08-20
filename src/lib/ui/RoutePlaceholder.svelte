<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  interface Props {
    title?: string;
    titleKey?: string;
  }

  let { title, titleKey }: Props = $props();

  let pageTitle = $derived(title ?? (titleKey ? $i18n.t(titleKey) : ''));
</script>

<svelte:head>
  <title>{pageTitle} - Sable</title>
</svelte:head>
