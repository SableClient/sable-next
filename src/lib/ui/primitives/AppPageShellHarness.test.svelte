<script lang="ts">
  import { untrack } from 'svelte';
  import { providePageMeta, type PageMeta } from '#lib/core/page-meta.js';
  import AppPageShell from './AppPageShell.svelte';

  let { title, pageMeta }: { title: string; pageMeta: PageMeta } = $props();
  providePageMeta(untrack(() => pageMeta));
</script>

<AppPageShell {title} />
