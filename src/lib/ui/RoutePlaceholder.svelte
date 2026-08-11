<script lang="ts">
  import { i18n } from '$lib/i18n';

  interface Props {
    title?: string;
    titleKey?: string;
    description?: string;
  }

  let { title, titleKey, description }: Props = $props();
  let pageTitle = $derived(title ?? (titleKey ? $i18n.t(titleKey) : ''));
</script>

<svelte:head>
  <title>{pageTitle} · Sable</title>
</svelte:head>

{#if description}
  <main>
    <h1>{pageTitle}</h1>
    <p>{description}</p>
  </main>
{:else}
  <h1>{pageTitle}</h1>
{/if}
