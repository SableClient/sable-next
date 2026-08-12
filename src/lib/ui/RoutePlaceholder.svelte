<script lang="ts">
  import { i18n } from '$lib/i18n';
  import AppPageShell from './primitives/AppPageShell.svelte';

  interface Props {
    title?: string;
    titleKey?: string;
    description?: string;
  }

  let { title, titleKey, description }: Props = $props();
  let pageTitle = $derived(title ?? (titleKey ? $i18n.t(titleKey) : ''));
</script>

<AppPageShell title={pageTitle} {description} />
